import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { BadgeInput } from '../schemas/ring-schemas';
import { logger } from './logger';

/**
 * Badge JSON-LD schema for ThreadRing membership badges
 * Based on Open Badges 3.0 specification with ThreadRing extensions
 */
export interface ThreadRingBadge {
  '@context': string[];
  id: string;
  type: string[];
  issuer: {
    id: string;
    type: string;
    name: string;
    url?: string;
  };
  credentialSubject: {
    id: string; // DID of the badge holder
    type: string[];
    achievement: {
      id: string;
      type: string[];
      name: string;
      description: string;
      criteria: {
        narrative: string;
      };
    };
  };
  issuanceDate: string;
  expirationDate?: string;
  proof: {
    type: string;
    created: string;
    verificationMethod: string;
    proofPurpose: string;
    jws: string; // JSON Web Signature
  };
  // ThreadRing-specific extensions
  threadRing: {
    ringSlug: string;
    ringName: string;
    memberRole: string;
    joinDate: string;
    ringHubUrl: string;
    badgeVersion: string;
  };
}

/**
 * Generate a cryptographically signed badge for ring membership
 */
export async function generateBadge(
  ringSlug: string,
  ringName: string,
  actorDid: string,
  actorName: string,
  role: string,
  privateKey: crypto.KeyObject,
  ringHubUrl: string
): Promise<ThreadRingBadge> {
  const badgeId = nanoid();
  const issuanceDate = new Date().toISOString();
  const issuerDid = `did:web:${new URL(ringHubUrl).hostname}`;

  const badge: Omit<ThreadRingBadge, 'proof'> = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://purl.imsglobal.org/spec/ob/v3p0/context.json',
      'https://threadring.org/contexts/v1'
    ],
    id: `${ringHubUrl}/badges/${badgeId}`,
    type: ['VerifiableCredential', 'OpenBadgeCredential', 'ThreadRingMembershipBadge'],
    issuer: {
      id: issuerDid,
      type: 'Profile',
      name: `ThreadRing Hub - ${ringName}`,
      url: ringHubUrl,
    },
    credentialSubject: {
      id: actorDid,
      type: ['Profile'],
      achievement: {
        id: `${ringHubUrl}/rings/${ringSlug}/achievement`,
        type: ['Achievement'],
        name: `${ringName} Member`,
        description: `Verified member of the ${ringName} ThreadRing community with ${role} privileges`,
        criteria: {
          narrative: `Membership verified through cryptographic authentication and Ring Hub consensus`
        }
      }
    },
    issuanceDate,
    threadRing: {
      ringSlug,
      ringName,
      memberRole: role,
      joinDate: issuanceDate,
      ringHubUrl,
      badgeVersion: '1.0.0'
    }
  };

  // Generate proof (JWS signature)
  const proof = await generateBadgeProof(badge, privateKey, issuerDid);
  
  return {
    ...badge,
    proof
  };
}

/**
 * Generate cryptographic proof for a badge
 */
async function generateBadgeProof(
  badge: Omit<ThreadRingBadge, 'proof'>,
  privateKey: crypto.KeyObject,
  issuerDid: string
): Promise<ThreadRingBadge['proof']> {
  const header = {
    alg: 'EdDSA',
    typ: 'JWT'
  };

  const payload = {
    iss: issuerDid,
    sub: badge.credentialSubject.id,
    iat: Math.floor(new Date(badge.issuanceDate).getTime() / 1000),
    exp: badge.expirationDate ? Math.floor(new Date(badge.expirationDate).getTime() / 1000) : undefined,
    vc: badge
  };

  // Create JWS
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);
  const signatureB64 = signature.toString('base64url');
  const jws = `${headerB64}.${payloadB64}.${signatureB64}`;

  return {
    type: 'Ed25519Signature2020',
    created: new Date().toISOString(),
    verificationMethod: `${issuerDid}#key-1`,
    proofPurpose: 'assertionMethod',
    jws
  };
}

/**
 * Verify a badge signature
 */
export async function verifyBadge(
  badge: ThreadRingBadge,
  publicKey: crypto.KeyObject
): Promise<{ isValid: boolean; error?: string }> {
  try {
    const { jws } = badge.proof;
    const [headerB64, payloadB64, signatureB64] = jws.split('.');

    if (!headerB64 || !payloadB64 || !signatureB64) {
      return { isValid: false, error: 'Invalid JWS format' };
    }

    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64, 'base64url');

    const isValid = crypto.verify(null, Buffer.from(signingInput), publicKey, signature);
    
    if (!isValid) {
      return { isValid: false, error: 'Invalid signature' };
    }

    // Verify expiration
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return { isValid: false, error: 'Badge expired' };
    }

    return { isValid: true };
  } catch (error) {
    logger.error({ error, badgeId: badge.id }, 'Badge verification failed');
    return { isValid: false, error: 'Verification error' };
  }
}

/**
 * Revoke a badge by adding it to a revocation list
 */
export async function revokeBadge(
  badgeId: string,
  reason: string,
  revokedBy: string
): Promise<{ revocationId: string; revokedAt: string }> {
  const revocationId = nanoid();
  const revokedAt = new Date().toISOString();

  // In a production system, this would be stored in a database
  // and published to a revocation list endpoint
  logger.info({
    badgeId,
    revocationId,
    reason,
    revokedBy,
    revokedAt
  }, 'Badge revoked');

  return { revocationId, revokedAt };
}

/**
 * Check if a badge is revoked
 */
export async function isBadgeRevoked(badgeId: string): Promise<boolean> {
  // In production, this would check against the revocation list
  // For now, return false (not revoked)
  return false;
}