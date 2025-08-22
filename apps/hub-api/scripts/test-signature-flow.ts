#!/usr/bin/env tsx

/**
 * Test script to verify the complete HTTP signature flow
 * This generates a test key pair, creates a mock DID document, and tests signature verification
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { verifyHttpSignature } from '../src/security/http-signature';
import { resolveDID, extractPublicKey } from '../src/security/did-resolver';

// Base58 encoding (same as your client)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer: Uint8Array): string {
  let num = BigInt('0x' + Buffer.from(buffer).toString('hex'));
  let encoded = '';
  
  while (num > 0) {
    const remainder = Number(num % 58n);
    encoded = ALPHABET[remainder] + encoded;
    num = num / 58n;
  }
  
  // Handle leading zeros
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  
  return encoded;
}

// Mock DID resolver for testing
const testDIDs: { [did: string]: any } = {};

// Override the global fetch to serve our test DID
const originalFetch = global.fetch;
global.fetch = async (url: string, options?: any) => {
  if (url === 'https://test.example.com/.well-known/did.json') {
    return {
      ok: true,
      json: async () => testDIDs['did:web:test.example.com'],
    } as Response;
  }
  return originalFetch(url, options);
};

async function testSignatureFlow() {
  console.log('🧪 Testing HTTP Signature Flow');
  console.log('==============================\n');

  // 1. Generate Ed25519 key pair
  console.log('1️⃣ Generating Ed25519 key pair...');
  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = await ed.getPublicKey(privateKeyBytes);
  
  console.log(`   Private key: ${Buffer.from(privateKeyBytes).toString('hex')}`);
  console.log(`   Public key: ${Buffer.from(publicKeyBytes).toString('hex')}`);
  console.log(`   Public key base64: ${Buffer.from(publicKeyBytes).toString('base64')}`);
  
  // 2. Create multibase public key (same format as your client)
  console.log('\n2️⃣ Creating multibase public key...');
  const multicodecPrefix = Buffer.from([0xed, 0x01]); // Ed25519 multicodec
  const multicodecKey = Buffer.concat([multicodecPrefix, publicKeyBytes]);
  const publicKeyMultibase = 'z' + base58Encode(multicodecKey);
  
  console.log(`   Multibase key: ${publicKeyMultibase}`);
  
  // 3. Create mock DID document
  console.log('\n3️⃣ Creating mock DID document...');
  const testDID = 'did:web:test.example.com';
  const keyId = `${testDID}#key-1`;
  
  testDIDs[testDID] = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1'
    ],
    id: testDID,
    verificationMethod: [{
      id: keyId,
      type: 'Ed25519VerificationKey2020',
      controller: testDID,
      publicKeyMultibase: publicKeyMultibase
    }],
    authentication: [keyId],
    assertionMethod: [keyId],
  };
  
  console.log(`   DID: ${testDID}`);
  console.log(`   Key ID: ${keyId}`);
  
  // 4. Test key extraction from DID document
  console.log('\n4️⃣ Testing key extraction...');
  const didDoc = await resolveDID(testDID);
  if (!didDoc) {
    console.error('❌ Failed to resolve test DID');
    return;
  }
  
  const extractedKey = extractPublicKey(didDoc, keyId);
  if (!extractedKey) {
    console.error('❌ Failed to extract public key from DID document');
    return;
  }
  
  console.log(`   Extracted key: ${extractedKey}`);
  console.log(`   Expected key: ${Buffer.from(publicKeyBytes).toString('base64')}`);
  console.log(`   Keys match: ${extractedKey === Buffer.from(publicKeyBytes).toString('base64')}`);
  
  // 5. Create test HTTP request data
  console.log('\n5️⃣ Creating test HTTP request...');
  const method = 'POST';
  const path = '/trp/rings';
  const host = 'test.example.com';
  const date = new Date().toUTCString();
  const body = JSON.stringify({ name: 'Test Ring' });
  const digest = 'sha-256=' + Buffer.from(sha256(body)).toString('base64');
  
  console.log(`   Method: ${method}`);
  console.log(`   Path: ${path}`);
  console.log(`   Host: ${host}`);
  console.log(`   Date: ${date}`);
  console.log(`   Digest: ${digest}`);
  
  // 6. Build signing string
  console.log('\n6️⃣ Building signing string...');
  const signingString = [
    `(request-target): ${method.toLowerCase()} ${path}`,
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`
  ].join('\n');
  
  console.log(`   Signing string:\n${signingString}`);
  
  // 7. Sign with private key
  console.log('\n7️⃣ Signing with private key...');
  const messageBytes = new TextEncoder().encode(signingString);
  const signatureBytes = await ed.sign(messageBytes, privateKeyBytes);
  const signatureBase64 = Buffer.from(signatureBytes).toString('base64');
  
  console.log(`   Signature: ${signatureBase64}`);
  
  // 8. Create HTTP signature header
  console.log('\n8️⃣ Creating HTTP signature header...');
  const signatureHeader = [
    `keyId="${keyId}"`,
    'algorithm="ed25519"',
    'headers="(request-target) host date digest"',
    `signature="${signatureBase64}"`
  ].join(',');
  
  console.log(`   Signature header: ${signatureHeader}`);
  
  // 9. Create mock Fastify request
  console.log('\n9️⃣ Creating mock HTTP request...');
  const mockRequest = {
    method: method,
    url: path,
    headers: {
      'authorization': `Signature ${signatureHeader}`,
      'host': host,
      'date': date,
      'digest': digest,
      'content-type': 'application/json',
    },
    body: JSON.parse(body),
  } as any;
  
  // 10. Test signature verification
  console.log('\n🔟 Testing signature verification...');
  try {
    const result = await verifyHttpSignature(mockRequest);
    
    console.log(`   Valid: ${result.valid}`);
    console.log(`   Actor DID: ${result.actorDid}`);
    console.log(`   Key ID: ${result.keyId}`);
    console.log(`   Error: ${result.error || 'None'}`);
    
    if (result.valid) {
      console.log('\n✅ SUCCESS: Signature verification passed!');
      console.log('\n🎉 The HTTP signature flow is working correctly.');
    } else {
      console.log('\n❌ FAILED: Signature verification failed');
      console.log(`   Reason: ${result.error}`);
    }
    
  } catch (error) {
    console.error('\n💥 ERROR during signature verification:', error);
  }
}

// Run the test
testSignatureFlow().catch(console.error);