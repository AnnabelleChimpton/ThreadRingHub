/**
 * ThreadRing DID Generator
 *
 * Core library for generating DIDs and keypairs
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure sha512 for ed25519
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(buffer: Uint8Array): string {
  let num = BigInt('0x' + Buffer.from(buffer).toString('hex'));
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = ALPHABET[remainder] + encoded;
    num = num / 58n;
  }

  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  return encoded || '1';
}

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  privateKeyBase64: string;
  publicKeyBase64: string;
  publicKeyMultibase: string;
}

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyBase64?: string;
    publicKeyMultibase?: string;
  }>;
  authentication: string[];
  assertionMethod: string[];
  service?: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
  name?: string;
  image?: string;
}

export interface GenerateOptions {
  domain: string;
  name?: string;
  avatar?: string;
  profileUrl?: string;
  keyFormat?: 'base64' | 'multibase';
}

/**
 * Generate a new Ed25519 keypair
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKey(privateKey);

  const privateKeyBase64 = Buffer.from(privateKey).toString('base64');
  const publicKeyBase64 = Buffer.from(publicKey).toString('base64');

  // Create multibase format
  const multicodecPrefix = Buffer.from([0xed, 0x01]);
  const multicodecKey = Buffer.concat([multicodecPrefix, Buffer.from(publicKey)]);
  const publicKeyMultibase = 'z' + base58Encode(multicodecKey);

  return {
    privateKey,
    publicKey,
    privateKeyBase64,
    publicKeyBase64,
    publicKeyMultibase,
  };
}

/**
 * Generate a complete DID and keypair for a domain
 */
export async function generateDID(options: GenerateOptions): Promise<{
  keyPair: KeyPair;
  did: string;
  keyId: string;
  document: DIDDocument;
}> {
  const { domain, name, avatar, profileUrl, keyFormat = 'base64' } = options;

  const keyPair = await generateKeyPair();

  const did = `did:web:${domain}`;
  const keyId = `${did}#key-1`;

  const document: DIDDocument = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        ...(keyFormat === 'multibase'
          ? { publicKeyMultibase: keyPair.publicKeyMultibase }
          : { publicKeyBase64: keyPair.publicKeyBase64 }),
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
    service: [
      {
        id: `${did}#profile`,
        type: 'Profile',
        serviceEndpoint: profileUrl || `https://${domain}/`,
      },
    ],
  };

  if (name) {
    document.name = name;
  }

  if (avatar) {
    document.image = avatar;
  }

  return {
    keyPair,
    did,
    keyId,
    document,
  };
}

/**
 * Resolve a did:web DID to its document URL
 */
export function didToUrl(did: string): string {
  if (!did.startsWith('did:web:')) {
    throw new Error('Only did:web DIDs are supported');
  }

  const parts = did.split(':').slice(2);

  if (parts.length === 1) {
    return `https://${parts[0]}/.well-known/did.json`;
  }

  return `https://${parts[0]}/${parts.slice(1).join('/')}/did.json`;
}

export { ed };
