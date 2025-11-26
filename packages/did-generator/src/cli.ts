#!/usr/bin/env node

import { Command } from 'commander';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import * as fs from 'fs';
import * as path from 'path';

// Configure sha512 for ed25519
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer: Uint8Array): string {
  let num = BigInt('0x' + Buffer.from(buffer).toString('hex'));
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = ALPHABET[remainder] + encoded;
    num = num / 58n;
  }

  // Handle leading zeros
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  return encoded || '1';
}

interface GenerateOptions {
  domain: string;
  name?: string;
  avatar?: string;
  profile?: string;
  output?: string;
  keyFormat?: 'base64' | 'multibase';
}

async function generateDID(options: GenerateOptions): Promise<void> {
  const { domain, name, avatar, profile, output, keyFormat = 'base64' } = options;

  console.log('\n🔐 ThreadRing DID Generator\n');
  console.log('='.repeat(50));

  // Generate Ed25519 keypair
  console.log('\n📝 Generating Ed25519 keypair...');
  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = await ed.getPublicKey(privateKeyBytes);

  const privateKeyBase64 = Buffer.from(privateKeyBytes).toString('base64');
  const publicKeyBase64 = Buffer.from(publicKeyBytes).toString('base64');

  // Create multibase format for public key
  const multicodecPrefix = Buffer.from([0xed, 0x01]); // Ed25519 multicodec
  const multicodecKey = Buffer.concat([multicodecPrefix, Buffer.from(publicKeyBytes)]);
  const publicKeyMultibase = 'z' + base58Encode(multicodecKey);

  // Build DID
  const did = `did:web:${domain}`;
  const keyId = `${did}#key-1`;
  const profileUrl = profile || `https://${domain}/`;

  // Create DID document
  const didDocument: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1'
    ],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        ...(keyFormat === 'multibase'
          ? { publicKeyMultibase }
          : { publicKeyBase64 })
      }
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
    service: [
      {
        id: `${did}#profile`,
        type: 'Profile',
        serviceEndpoint: profileUrl
      }
    ]
  };

  // Add optional fields
  if (name) {
    didDocument.name = name;
  }
  if (avatar) {
    didDocument.image = avatar;
  }

  // Output results
  console.log('\n✅ Keys generated successfully!\n');
  console.log('='.repeat(50));
  console.log('\n🆔 Your DID:', did);
  console.log('🔑 Key ID:', keyId);

  console.log('\n' + '='.repeat(50));
  console.log('⚠️  PRIVATE KEY - KEEP THIS SECRET!\n');
  console.log(privateKeyBase64);
  console.log('\n' + '='.repeat(50));

  console.log('\n📄 DID Document (did.json):\n');
  const didJson = JSON.stringify(didDocument, null, 2);
  console.log(didJson);

  // Save files if output directory specified
  if (output) {
    const outputDir = path.resolve(output);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save DID document
    const didPath = path.join(outputDir, 'did.json');
    fs.writeFileSync(didPath, didJson);
    console.log(`\n💾 Saved: ${didPath}`);

    // Save private key (with warning)
    const keyPath = path.join(outputDir, 'private-key.txt');
    fs.writeFileSync(keyPath, `# PRIVATE KEY - KEEP THIS SECRET!\n# Never commit this file to version control.\n# Store securely as an environment variable.\n\n${privateKeyBase64}\n`);
    console.log(`💾 Saved: ${keyPath}`);

    // Save instructions
    const instructionsPath = path.join(outputDir, 'INSTRUCTIONS.md');
    const instructions = `# ThreadRing Setup Instructions

## Your Identity

- **DID:** \`${did}\`
- **Key ID:** \`${keyId}\`

## Setup Steps

### 1. Host Your DID Document

Upload \`did.json\` to your website at:

\`\`\`
https://${domain}/.well-known/did.json
\`\`\`

### 2. Verify It Works

\`\`\`bash
curl https://${domain}/.well-known/did.json
\`\`\`

### 3. Store Your Private Key

Set your private key as an environment variable:

\`\`\`bash
export THREADRING_PRIVATE_KEY="${privateKeyBase64}"
\`\`\`

Or add to your \`.env\` file (never commit this!):

\`\`\`
THREADRING_PRIVATE_KEY=${privateKeyBase64}
\`\`\`

### 4. Join a Ring

Use the ThreadRing client to join rings and submit content.

See: https://github.com/threadring/hub for more details.

## Security Notes

- Never share your private key
- Never commit private-key.txt to version control
- Use environment variables in production
- Your DID document must be served over HTTPS
`;
    fs.writeFileSync(instructionsPath, instructions);
    console.log(`💾 Saved: ${instructionsPath}`);
  }

  // Print next steps
  console.log('\n' + '='.repeat(50));
  console.log('\n📋 Next Steps:\n');
  console.log('1. Save your private key securely (environment variable)');
  console.log(`2. Upload did.json to: https://${domain}/.well-known/did.json`);
  console.log(`3. Verify with: curl https://${domain}/.well-known/did.json`);
  console.log('4. Join rings at https://ringhub.io');
  console.log('\n🔗 Documentation: https://github.com/threadring/hub/docs/PERSONAL_SITE_GUIDE.md');
  console.log('');
}

// CLI setup
const program = new Command();

program
  .name('threadring-did')
  .description('Generate DID documents and keypairs for ThreadRing')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate a new DID and keypair')
  .requiredOption('-d, --domain <domain>', 'Your domain (e.g., example.com)')
  .option('-n, --name <name>', 'Your display name')
  .option('-a, --avatar <url>', 'Avatar image URL')
  .option('-p, --profile <url>', 'Profile page URL (defaults to domain root)')
  .option('-o, --output <dir>', 'Output directory for generated files')
  .option('-f, --key-format <format>', 'Key format: base64 or multibase', 'base64')
  .action(async (options) => {
    try {
      await generateDID(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('verify')
  .description('Verify a DID document is accessible')
  .argument('<did>', 'DID to verify (e.g., did:web:example.com)')
  .action(async (did: string) => {
    console.log(`\n🔍 Verifying DID: ${did}\n`);

    if (!did.startsWith('did:web:')) {
      console.error('❌ Only did:web DIDs are supported');
      process.exit(1);
    }

    // Parse DID to URL
    const parts = did.split(':').slice(2);
    let url: string;

    if (parts.length === 1) {
      url = `https://${parts[0]}/.well-known/did.json`;
    } else {
      url = `https://${parts[0]}/${parts.slice(1).join('/')}/did.json`;
    }

    console.log(`📡 Fetching: ${url}\n`);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        console.error(`❌ HTTP ${response.status}: ${response.statusText}`);
        process.exit(1);
      }

      const doc = await response.json();

      // Validate basic structure
      const checks = [
        { name: 'Has @context', pass: Array.isArray(doc['@context']) },
        { name: 'Has id', pass: doc.id === did },
        { name: 'Has verificationMethod', pass: Array.isArray(doc.verificationMethod) && doc.verificationMethod.length > 0 },
        { name: 'Has authentication', pass: Array.isArray(doc.authentication) && doc.authentication.length > 0 },
        { name: 'Has Profile service', pass: Array.isArray(doc.service) && doc.service.some((s: { type: string }) => s.type === 'Profile') },
      ];

      console.log('Validation Results:\n');
      let allPassed = true;
      for (const check of checks) {
        const icon = check.pass ? '✅' : '❌';
        console.log(`  ${icon} ${check.name}`);
        if (!check.pass) allPassed = false;
      }

      console.log('');
      if (allPassed) {
        console.log('✅ DID document is valid and accessible!');
      } else {
        console.log('⚠️  Some checks failed. Review your DID document.');
        process.exit(1);
      }

    } catch (error) {
      console.error('❌ Failed to fetch DID document:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
