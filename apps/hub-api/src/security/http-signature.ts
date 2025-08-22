import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { FastifyRequest } from 'fastify';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';

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
  headers: string[]
): string {
  const lines: string[] = [];
  
  for (const header of headers) {
    if (header === '(request-target)') {
      // Special case: request target
      const method = request.method.toLowerCase();
      const path = request.url;
      lines.push(`(request-target): ${method} ${path}`);
    } else if (header === '(created)') {
      // Special case: created timestamp
      const created = Math.floor(Date.now() / 1000);
      lines.push(`(created): ${created}`);
    } else if (header === '(expires)') {
      // Special case: expires timestamp
      const expires = Math.floor(Date.now() / 1000) + 300; // 5 minutes
      lines.push(`(expires): ${expires}`);
    } else if (header === 'digest') {
      // Special case: body digest
      const body = JSON.stringify(request.body || '');
      const digest = Buffer.from(sha256(body)).toString('base64');
      lines.push(`digest: SHA-256=${digest}`);
    } else {
      // Regular header
      const value = request.headers[header.toLowerCase()];
      if (value) {
        lines.push(`${header.toLowerCase()}: ${value}`);
      }
    }
  }
  
  return lines.join('\n');
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
    const messageBytes = new TextEncoder().encode(message);
    
    // Verify signature
    return await ed.verify(signatureBytes, messageBytes, pubKeyBytes);
  } catch (error) {
    logger.error({ error }, 'Failed to verify Ed25519 signature');
    return false;
  }
}

/**
 * Fetch public key for a given keyId
 */
async function fetchPublicKey(keyId: string): Promise<string | null> {
  try {
    // First, check if we have it cached in the database
    const cached = await prisma.httpSignature.findUnique({
      where: { keyId },
    });
    
    if (cached) {
      // Update last used timestamp
      await prisma.httpSignature.update({
        where: { keyId },
        data: { lastUsed: new Date() },
      });
      
      return cached.publicKey;
    }
    
    // If keyId is a URL, we could fetch it (e.g., from a did:web document)
    // For now, we'll just return null if not found
    // In production, this would fetch from the DID document
    
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
    // Get signature header
    const signatureHeader = request.headers['signature'] as string;
    if (!signatureHeader) {
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
    
    // Fetch public key
    const publicKey = await fetchPublicKey(components.keyId);
    if (!publicKey) {
      return { 
        valid: false, 
        error: `Unknown key: ${components.keyId}` 
      };
    }
    
    // Build signing string
    const signingString = buildSigningString(request, components.headers);
    
    // Verify signature
    const valid = await verifyEd25519Signature(
      publicKey,
      signingString,
      components.signature
    );
    
    if (!valid) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    // Get actor DID from key
    const key = await prisma.httpSignature.findUnique({
      where: { keyId: components.keyId },
      select: { actorDid: true },
    });
    
    return {
      valid: true,
      actorDid: key?.actorDid,
      keyId: components.keyId,
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
 * Generate HTTP signature for outgoing requests
 */
export async function generateHttpSignature(
  method: string,
  url: string,
  headers: Record<string, string>,
  privateKey: string,
  keyId: string
): Promise<string> {
  try {
    // Build signing string
    const requestTarget = `(request-target): ${method.toLowerCase()} ${url}`;
    const date = `date: ${headers['date'] || new Date().toUTCString()}`;
    const host = `host: ${headers['host'] || new URL(url).host}`;
    
    const signingString = [requestTarget, host, date].join('\n');
    
    // Sign with Ed25519
    const privateKeyBytes = Buffer.from(privateKey, 'base64');
    const messageBytes = new TextEncoder().encode(signingString);
    const signatureBytes = await ed.sign(messageBytes, privateKeyBytes);
    const signature = Buffer.from(signatureBytes).toString('base64');
    
    // Build signature header
    return [
      `keyId="${keyId}"`,
      `algorithm="ed25519"`,
      `headers="(request-target) host date"`,
      `signature="${signature}"`,
    ].join(',');
  } catch (error) {
    logger.error({ error }, 'Failed to generate HTTP signature');
    throw error;
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