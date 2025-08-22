import { logger } from '../utils/logger';
import { getCached, setCached } from '../database/redis';

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  service?: Service[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyBase64?: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: any;
}

export interface Service {
  id: string;
  type: string;
  serviceEndpoint: string;
}

/**
 * Resolve a DID to its document
 */
export async function resolveDID(did: string): Promise<DIDDocument | null> {
  try {
    // Check cache first
    const cacheKey = `did:${did}`;
    const cached = await getCached<DIDDocument>(cacheKey);
    if (cached) {
      return cached;
    }

    let document: DIDDocument | null = null;

    if (did.startsWith('did:web:')) {
      document = await resolveWebDID(did);
    } else if (did.startsWith('did:key:')) {
      document = await resolveKeyDID(did);
    } else {
      logger.warn({ did }, 'Unsupported DID method');
      return null;
    }

    // Cache the result for 1 hour
    if (document) {
      await setCached(cacheKey, document, 3600);
    }

    return document;
  } catch (error) {
    logger.error({ error, did }, 'Failed to resolve DID');
    return null;
  }
}

/**
 * Resolve a did:web DID
 * did:web:example.com:users:alice -> https://example.com/users/alice/did.json
 */
async function resolveWebDID(did: string): Promise<DIDDocument | null> {
  try {
    // Parse did:web format
    const parts = did.split(':');
    if (parts.length < 3) {
      return null;
    }

    // Remove 'did:web:' prefix
    const domain = parts.slice(2).join(':');
    
    // Convert to URL
    // Replace colons with slashes for path components
    const urlPath = domain.replace(/:/g, '/');
    const url = `https://${urlPath}/.well-known/did.json`;

    // In production, this would make an HTTP request
    // For now, we'll create a mock response for local development
    if (did.includes('localhost')) {
      return createMockWebDID(did);
    }

    // Fetch DID document from URL
    logger.info({ url }, 'Fetching DID document from URL');
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'RingHub-DID-Resolver/1.0',
        },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'Failed to fetch DID document');
        return null;
      }

      const document = await response.json() as DIDDocument;
      logger.info({ url, did: document.id }, 'Successfully fetched DID document');
      return document;
    } catch (fetchError) {
      logger.error({ error: fetchError, url }, 'HTTP fetch failed for DID document');
      return null;
    }
  } catch (error) {
    logger.error({ error, did }, 'Failed to resolve did:web');
    return null;
  }
}

/**
 * Resolve a did:key DID (self-contained)
 */
async function resolveKeyDID(did: string): Promise<DIDDocument | null> {
  try {
    // did:key DIDs contain the public key in the identifier
    // Format: did:key:z6Mk...
    const parts = did.split(':');
    if (parts.length !== 3) {
      return null;
    }

    const multibaseKey = parts[2];
    
    // Create a minimal DID document
    const document: DIDDocument = {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
      ],
      id: did,
      verificationMethod: [
        {
          id: `${did}#${multibaseKey}`,
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyMultibase: multibaseKey,
        },
      ],
      authentication: [`${did}#${multibaseKey}`],
      assertionMethod: [`${did}#${multibaseKey}`],
    };

    return document;
  } catch (error) {
    logger.error({ error, did }, 'Failed to resolve did:key');
    return null;
  }
}

/**
 * Create a mock did:web document for local development
 */
function createMockWebDID(did: string): DIDDocument {
  // Generate a mock Ed25519 public key (32 bytes base64)
  const mockPublicKey = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: `${did}#key-1`,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyBase64: mockPublicKey,
      },
    ],
    authentication: [`${did}#key-1`],
    assertionMethod: [`${did}#key-1`],
    service: [
      {
        id: `${did}#ring-hub`,
        type: 'RingHub',
        serviceEndpoint: 'http://localhost:3100/trp',
      },
    ],
  };
}

/**
 * Extract public key from DID document
 */
export function extractPublicKey(
  document: DIDDocument,
  keyId?: string
): string | null {
  try {
    if (!document.verificationMethod || document.verificationMethod.length === 0) {
      return null;
    }

    // Find the specified key or use the first one
    let method: VerificationMethod | undefined;
    
    if (keyId) {
      method = document.verificationMethod.find(m => m.id === keyId);
    } else {
      method = document.verificationMethod[0];
    }

    if (!method) {
      return null;
    }

    // Return the public key in the appropriate format
    if (method.publicKeyBase64) {
      return method.publicKeyBase64;
    }

    if (method.publicKeyMultibase) {
      // Convert multibase to base64 if needed
      // For now, return as-is
      return method.publicKeyMultibase;
    }

    return null;
  } catch (error) {
    logger.error({ error }, 'Failed to extract public key from DID document');
    return null;
  }
}

/**
 * Verify that a DID controls a given key
 */
export async function verifyDIDOwnership(
  did: string,
  keyId: string
): Promise<boolean> {
  try {
    const document = await resolveDID(did);
    if (!document) {
      return false;
    }

    // Check if the key is listed in the document
    const hasKey = document.verificationMethod?.some(m => m.id === keyId);
    if (!hasKey) {
      return false;
    }

    // Check if the key is authorized for authentication
    const isAuthenticated = document.authentication?.some(auth => {
      if (typeof auth === 'string') {
        return auth === keyId;
      }
      return auth.id === keyId;
    });

    return isAuthenticated || false;
  } catch (error) {
    logger.error({ error, did, keyId }, 'Failed to verify DID ownership');
    return false;
  }
}