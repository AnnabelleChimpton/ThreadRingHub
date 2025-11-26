# @threadring/did-generator

Generate DID documents and Ed25519 keypairs for ThreadRing.

## Quick Start

```bash
npx @threadring/did-generator generate --domain yourdomain.com --name "Your Name"
```

## Installation

```bash
npm install @threadring/did-generator
# or
pnpm add @threadring/did-generator
```

## CLI Usage

### Generate a new DID

```bash
# Basic usage
threadring-did generate --domain example.com

# With all options
threadring-did generate \
  --domain example.com \
  --name "Alice Smith" \
  --avatar "https://example.com/avatar.jpg" \
  --profile "https://example.com/about" \
  --output ./did-output \
  --key-format multibase
```

**Options:**

| Flag | Description | Required |
|------|-------------|----------|
| `-d, --domain` | Your domain | Yes |
| `-n, --name` | Display name | No |
| `-a, --avatar` | Avatar URL | No |
| `-p, --profile` | Profile page URL | No |
| `-o, --output` | Output directory | No |
| `-f, --key-format` | `base64` or `multibase` | No (default: base64) |

### Verify a DID

```bash
threadring-did verify did:web:example.com
```

## Programmatic Usage

```typescript
import { generateDID, generateKeyPair } from '@threadring/did-generator';

// Generate complete DID with document
const result = await generateDID({
  domain: 'example.com',
  name: 'Alice Smith',
  avatar: 'https://example.com/avatar.jpg',
});

console.log(result.did);                    // did:web:example.com
console.log(result.keyId);                  // did:web:example.com#key-1
console.log(result.keyPair.privateKeyBase64); // Base64 private key
console.log(result.document);               // Complete DID document

// Generate just a keypair
const keyPair = await generateKeyPair();
console.log(keyPair.publicKeyBase64);
console.log(keyPair.publicKeyMultibase);
```

## Output Files

When using `--output`, the CLI generates:

- `did.json` - Your DID document (upload to `/.well-known/did.json`)
- `private-key.txt` - Your private key (keep secret!)
- `INSTRUCTIONS.md` - Setup guide

## Security

- **Never share your private key**
- **Never commit `private-key.txt`**
- Store private keys as environment variables
- Your DID document must be served over HTTPS

## Next Steps

1. Upload `did.json` to `https://yourdomain.com/.well-known/did.json`
2. Set `THREADRING_PRIVATE_KEY` environment variable
3. Join rings at https://ringhub.io

See the [Personal Site Guide](../../docs/PERSONAL_SITE_GUIDE.md) for complete setup instructions.
