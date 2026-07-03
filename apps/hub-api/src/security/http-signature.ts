import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { FastifyRequest } from 'fastify';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { resolveDID, extractPublicKey } from './did-resolver';

// Configure SHA-512 for @noble/ed25519
import { concatBytes } from '@noble/hashes/utils';
ed.etc.sha512Sync = (...m) => sha512(concatBytes(...m));

interface SignatureComponents {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
  created?: number;
  expires?: number;
}

interface VerificationResult {
  valid: boolean;
  actorDid?: string;
  keyId?: string;
  publicKey?: string;
  error?: string;
}

/**
 * Parse HTTP Signature header according to draft-cavage-http-signature
 */
function parseSignatureHeader(signatureHeader: string): SignatureComponents | null {
  try {
    const components: Partial<SignatureComponents> = {};
    
    // Parse key="value" pairs
    const regex = /(\w+)="([^"]+)"/g;
    let match;
    
    while ((match = regex.exec(signatureHeader)) !== null) {
      const [, key, value] = match;
      switch (key) {
        case 'keyId':
          components.keyId = value;
          break;
        case 'algorithm':
          components.algorithm = value;
          break;
        case 'headers':
          components.headers = value.split(' ');
          break;
        case 'signature':
          components.signature = value;
          break;
        case 'created':
          components.created = parseInt(value, 10);
          break;
        case 'expires':
          components.expires = parseInt(value, 10);
          break;
      }
    }
    
    // Validate required fields
    if (!components.keyId || !components.signature) {
      return null;
    }
    
    // Default headers if not specified
    if (!components.headers) {
      components.headers = ['(request-target)', 'date'];
    }
    
    // Default algorithm
    if (!components.algorithm) {
      components.algorithm = 'ed25519';
    }
    
    return components as SignatureComponents;
  } catch (error) {
    logger.error({ error }, 'Failed to parse signature header');
    return null;
  }
}

/**
 * Build the signing string from request headers
 */
function buildSigningString(
  request: FastifyRequest,
  headers: string[],
  components: SignatureComponents
): string {
  const lines: string[] = [];

  logger.info({
    method: request.method,
    url: request.url,
    headers: Object.keys(request.headers),
    requestHeaders: headers
  }, 'Building signing string from request');

  for (const header of headers) {
    if (header === '(request-target)') {
      // Special case: request target
      const method = request.method.toLowerCase();
      const path = request.url;
      const line = `(request-target): ${method} ${path}`;
      lines.push(line);
      logger.info({ line }, 'Added request-target to signing string');
    } else if (header === '(created)') {
      // Use the value the CLIENT signed (from the signature params), NOT a
      // locally recomputed Date.now() — recomputing guarantees a mismatch.
      const created = components.created;
      const line = `(created): ${created ?? ''}`;
      lines.push(line);
      logger.info({ line }, 'Added client-signed created to signing string');
    } else if (header === '(expires)') {
      // Use the value the CLIENT signed, not a locally recomputed one.
      const expires = components.expires;
      const line = `(expires): ${expires ?? ''}`;
      lines.push(line);
      logger.info({ line }, 'Added client-signed expires to signing string');
    } else if (header === 'digest') {
      // Include the client's Digest header verbatim in the signing string.
      // Correctness of the digest vs. the actual body is validated separately
      // in validateDigest() against the RAW request bytes.
      const value = request.headers['digest'];
      if (value) {
        const line = `digest: ${value}`;
        lines.push(line);
        logger.info({ line }, 'Added digest header to signing string');
      } else {
        logger.warn({ availableHeaders: Object.keys(request.headers) }, 'Digest listed in signed headers but no Digest header present');
      }
    } else {
      // Regular header
      const value = request.headers[header.toLowerCase()];
      if (value) {
        const line = `${header.toLowerCase()}: ${value}`;
        lines.push(line);
        logger.info({ header, value, line }, 'Added regular header to signing string');
      } else {
        logger.warn({ header, availableHeaders: Object.keys(request.headers) }, 'Missing header for signing string');
      }
    }
  }
  
  const signingString = lines.join('\n');
  logger.info({ 
    signingString: signingString.replace(/\n/g, '\\n'),
    lineCount: lines.length 
  }, 'Built complete signing string');
  
  return signingString;
}

/**
 * Verify Ed25519 signature
 */
async function verifyEd25519Signature(
  publicKey: string,
  message: string,
  signature: string
): Promise<boolean> {
  try {
    // Decode base64 public key and signature
    const pubKeyBytes = Buffer.from(publicKey, 'base64');
    const signatureBytes = Buffer.from(signature, 'base64');
    const messageBytes = Buffer.from(message, 'utf8');
    
    logger.info({
      publicKeyLength: pubKeyBytes.length,
      signatureLength: signatureBytes.length,
      messageLength: messageBytes.length,
      publicKeyHex: pubKeyBytes.toString('hex').substring(0, 16) + '...',
      signatureHex: signatureBytes.toString('hex').substring(0, 16) + '...',
      messagePreview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
    }, 'Ed25519 signature verification details');
    
    // Verify signature
    const isValid = await ed.verify(signatureBytes, messageBytes, pubKeyBytes);
    logger.info({ isValid }, 'Ed25519 signature verification result');
    return isValid;
  } catch (error) {
    logger.error({ 
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      publicKeyLength: publicKey.length,
      signatureLength: signature.length,
      messageLength: message.length,
    }, 'Failed to verify Ed25519 signature');
    return false;
  }
}

// How long a cached did:web key is trusted before it must be re-resolved from
// the DID document. Bounded so a rotated client key recovers within a day even
// if no verification failure triggers an earlier re-resolve.
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Resolve a key straight from its DID document (optionally bypassing the DID
 * doc cache) and, for did:web, upsert it into the DB cache with a fresh TTL.
 *
 * did:key keys are self-contained and are never cached in the DB.
 */
async function resolveKeyFromDID(
  keyId: string,
  forceRefresh: boolean = false
): Promise<string | null> {
  const did = keyId.split('#')[0];

  if (did.startsWith('did:web:')) {
    logger.info({ keyId, did, forceRefresh }, 'Resolving did:web DID for key');

    const didDocument = await resolveDID(did, forceRefresh);
    if (didDocument) {
      const publicKey = extractPublicKey(didDocument, keyId);
      if (publicKey) {
        // Upsert so both first-resolution and rotation updates land on the
        // same row, with a refreshed expiry.
        await prisma.httpSignature.upsert({
          where: { keyId },
          create: {
            keyId,
            publicKey,
            actorDid: did,
            trusted: false, // Keys start untrusted
            expiresAt: new Date(Date.now() + KEY_CACHE_TTL_MS),
          },
          update: {
            publicKey,
            expiresAt: new Date(Date.now() + KEY_CACHE_TTL_MS),
            lastUsed: new Date(),
          },
        });

        logger.info({ keyId, did }, 'Cached public key from did:web DID resolution');
        return publicKey;
      }
    }
    return null;
  }

  if (did.startsWith('did:key:')) {
    logger.info({ keyId, did }, 'Resolving did:key DID for key');

    // did:key is self-contained — resolve but don't cache in the DB.
    const didDocument = await resolveDID(did, forceRefresh);
    if (didDocument) {
      const publicKey = extractPublicKey(didDocument, keyId);
      if (publicKey) {
        logger.info({ keyId, did }, 'Resolved public key from did:key DID');
        return publicKey;
      }
    }
    return null;
  }

  logger.warn({ keyId, did }, 'Unsupported DID method for key resolution');
  return null;
}

// Maximum allowed difference between the signed Date header and the hub's
// clock, in seconds. Rejects replayed/stale requests without being so tight
// that normal clock drift between peers trips it.
const CLOCK_SKEW_SECONDS = 300;

/**
 * Validate the client's Digest header against the RAW request body bytes.
 *
 * Returns true when there is nothing to reject:
 *  - no Digest header present (e.g. GETs / bodyless requests) — skip the check
 *    entirely for backward-compat; a Digest is not required.
 *  - Digest present and it matches sha-256 base64 of the raw body bytes.
 *
 * Returns false only when a Digest header IS present and does NOT match the
 * actual body — i.e. the body was tampered with (or the client mis-computed).
 *
 * IMPORTANT: the digest MUST be computed over the exact raw bytes the client
 * hashed, not over a re-serialization of the parsed body (JSON.stringify would
 * reorder keys / change whitespace and mismatch).
 */
function validateDigest(request: FastifyRequest): boolean {
  const digestHeader = request.headers['digest'];
  if (!digestHeader || typeof digestHeader !== 'string') {
    // No Digest header — nothing to validate (bodyless request / GET).
    return true;
  }

  // Only sha-256 is supported. Header form: "sha-256=<base64>".
  const match = /^sha-256=(.+)$/i.exec(digestHeader.trim());
  if (!match) {
    logger.warn({ digestHeader }, 'Unsupported or malformed Digest header algorithm — rejecting');
    return false;
  }
  const claimedDigest = match[1];

  // Recover the raw bytes the client signed over.
  const rawBody: Buffer | undefined = (request as any).rawBody;
  if (rawBody === undefined) {
    // A Digest header was sent but we captured no raw body. Treat an empty
    // body as zero bytes so an explicit `sha-256=` over "" still validates.
    logger.warn('Digest header present but no raw body captured — treating body as empty');
  }
  const bodyBytes = rawBody !== undefined ? rawBody : Buffer.alloc(0);

  const computed = Buffer.from(sha256(bodyBytes)).toString('base64');

  if (computed !== claimedDigest) {
    logger.warn({
      claimedDigest,
      computedDigest: computed,
      bodyLength: bodyBytes.length,
    }, 'Digest header does not match request body — rejecting');
    return false;
  }

  logger.info('Digest header validated against raw body');
  return true;
}

/**
 * Fetch public key for a given keyId.
 *
 * Uses the DB cache but honours `expiresAt`: on a cache hit whose TTL has
 * lapsed, the DID document is re-resolved and the row updated with the fresh
 * key. If re-resolution fails (e.g. the DID doc is unreachable) we fall back to
 * the stale cached key rather than hard-failing authentication.
 */
async function fetchPublicKey(keyId: string): Promise<string | null> {
  try {
    // First, check if we have it cached in the database
    const cached = await prisma.httpSignature.findUnique({
      where: { keyId },
    });

    if (cached) {
      const expired = cached.expiresAt != null && cached.expiresAt.getTime() < Date.now();

      if (expired) {
        logger.info({ keyId, expiresAt: cached.expiresAt }, 'Cached key expired — re-resolving DID document');
        const fresh = await resolveKeyFromDID(keyId, /* forceRefresh */ true);
        if (fresh) {
          if (fresh !== cached.publicKey) {
            logger.warn({ keyId }, 'Cached key rotated on TTL refresh — swapped to newly resolved key');
          }
          return fresh;
        }
        // Re-resolution failed (DID doc unreachable). Fall back to the stale
        // cached key so a transient outage doesn't lock out the client.
        logger.warn({ keyId }, 'Could not re-resolve expired key — falling back to stale cached key');
      }

      // Update last used timestamp (best-effort)
      await prisma.httpSignature.update({
        where: { keyId },
        data: { lastUsed: new Date() },
      });

      return cached.publicKey;
    }

    // Unknown key: resolve from the DID document for the first time.
    const resolved = await resolveKeyFromDID(keyId, /* forceRefresh */ false);
    if (resolved) {
      return resolved;
    }

    logger.warn({ keyId }, 'Failed to resolve public key');
    return null;
  } catch (error) {
    logger.error({ error, keyId }, 'Failed to fetch public key');
    return null;
  }
}

/**
 * Verify HTTP signature on a request
 */
export async function verifyHttpSignature(
  request: FastifyRequest
): Promise<VerificationResult> {
  try {
    logger.info({ method: request.method, url: request.url }, 'Starting HTTP signature verification');
    
    // Get signature header (can be in 'signature' or 'authorization' header)
    let signatureHeader = request.headers['signature'] as string;
    
    // If not in 'signature' header, check 'authorization' header
    if (!signatureHeader) {
      const authHeader = request.headers['authorization'] as string;
      logger.info({ authHeader }, 'Checking authorization header for signature');
      if (authHeader && authHeader.startsWith('Signature ')) {
        signatureHeader = authHeader.substring('Signature '.length);
        logger.info({ signatureHeader }, 'Extracted signature from authorization header');
      }
    }
    
    if (!signatureHeader) {
      logger.warn('Missing signature header');
      return { valid: false, error: 'Missing signature header' };
    }
    
    // Parse signature components
    const components = parseSignatureHeader(signatureHeader);
    if (!components) {
      return { valid: false, error: 'Invalid signature header format' };
    }
    
    // Check algorithm
    if (components.algorithm !== 'ed25519' && 
        components.algorithm !== 'hs2019') {
      return { 
        valid: false, 
        error: `Unsupported algorithm: ${components.algorithm}` 
      };
    }
    
    // Check created/expires timestamps if present
    const now = Math.floor(Date.now() / 1000);
    if (components.created && components.created > now + 60) {
      return { valid: false, error: 'Signature created in the future' };
    }
    if (components.expires && components.expires < now) {
      return { valid: false, error: 'Signature expired' };
    }

    // Enforce clock-skew on the signed Date header (only when 'date' is among
    // the signed headers). Rejects stale/replayed requests.
    if (components.headers.includes('date')) {
      const dateHeader = request.headers['date'];
      if (dateHeader && typeof dateHeader === 'string') {
        const dateMs = Date.parse(dateHeader);
        if (Number.isNaN(dateMs)) {
          return { valid: false, error: 'Invalid Date header' };
        }
        const skewSeconds = Math.abs(Date.now() - dateMs) / 1000;
        if (skewSeconds > CLOCK_SKEW_SECONDS) {
          logger.warn({ dateHeader, skewSeconds }, 'Date header outside allowed clock-skew window');
          return { valid: false, error: 'Date header outside allowed clock-skew window' };
        }
      }
    }

    // Validate the Digest header against the raw body (skipped when absent).
    if (!validateDigest(request)) {
      return { valid: false, error: 'Digest does not match request body' };
    }

    // Fetch public key
    const publicKey = await fetchPublicKey(components.keyId);
    if (!publicKey) {
      return { 
        valid: false, 
        error: `Unknown key: ${components.keyId}` 
      };
    }
    
    logger.info({ 
      keyId: components.keyId,
      publicKey: publicKey,
      publicKeyLength: publicKey.length 
    }, 'Resolved public key for signature verification');
    
    // Build signing string (deterministic: created/expires come from the
    // client-signed params, not from the verifier's clock).
    const signingString = buildSigningString(request, components.headers, components);
    logger.info({
      signingString,
      publicKey: publicKey.substring(0, 16) + '...',
      signature: components.signature.substring(0, 16) + '...',
      headers: components.headers
    }, 'Verifying signature with details');

    // Verify signature
    // Get actor DID from key BEFORE verification (so it's available even if verification fails)
    const key = await prisma.httpSignature.findUnique({
      where: { keyId: components.keyId },
      select: { actorDid: true },
    });

    const actorDid = key?.actorDid || components.keyId.split('#')[0];

    let usedPublicKey = publicKey;
    let valid = await verifyEd25519Signature(
      usedPublicKey,
      signingString,
      components.signature
    );

    // Rotation self-heal: if verification fails against the (possibly cached)
    // key for a did:web keyId, force a single DID-document re-resolution and
    // retry. This lets a rotated client key recover immediately instead of
    // waiting for the cache TTL to lapse.
    if (!valid && components.keyId.split('#')[0].startsWith('did:web:')) {
      logger.info({ keyId: components.keyId }, 'Signature invalid — re-resolving DID document once to check for key rotation');
      const freshKey = await resolveKeyFromDID(components.keyId, /* forceRefresh */ true);
      if (freshKey && freshKey !== usedPublicKey) {
        logger.warn({ keyId: components.keyId }, 'Re-resolve swapped the cached key (rotation) — retrying verification with fresh key');
        usedPublicKey = freshKey;
        valid = await verifyEd25519Signature(
          usedPublicKey,
          signingString,
          components.signature
        );
      } else {
        logger.info({ keyId: components.keyId }, 'Re-resolve did not change the key — signature remains invalid');
      }
    }

    logger.info({ valid, keyId: components.keyId }, 'HTTP signature verification completed');

    if (!valid) {
      logger.warn({ keyId: components.keyId }, 'HTTP signature verification failed - invalid signature');
      return {
        valid: false,
        error: 'Invalid signature',
        actorDid,  // Include actorDid even when verification fails
        keyId: components.keyId,
        publicKey: usedPublicKey
      };
    }
    logger.info({
      keyId: components.keyId,
      actorDid,
      fromCache: !!key?.actorDid
    }, 'HTTP signature verification successful');

    return {
      valid: true,
      actorDid,
      keyId: components.keyId,
      publicKey: usedPublicKey,
    };
  } catch (error) {
    logger.error({ error }, 'HTTP signature verification failed');
    return { 
      valid: false, 
      error: 'Internal error during signature verification' 
    };
  }
}

/**
 * Middleware to verify HTTP signatures on protected routes
 */
export async function requireHttpSignature(
  request: FastifyRequest
): Promise<void> {
  const result = await verifyHttpSignature(request);
  
  if (!result.valid) {
    throw {
      statusCode: 401,
      message: result.error || 'Invalid signature',
    };
  }
  
  // Attach actor DID to request for use in route handlers
  (request as any).actorDid = result.actorDid;
  (request as any).keyId = result.keyId;
}