# Personal Site Integration Guide

Connect your personal website to the ThreadRing network. Join rings, submit posts, and display membership badges.

**Hub URL:** `https://ringhub.io`

---

## Table of Contents

1. [Concepts](#concepts)
2. [Quick Start](#quick-start)
3. [Step 1: Generate Your Keys](#step-1-generate-your-keys)
4. [Step 2: Create Your DID Document](#step-2-create-your-did-document)
5. [Step 3: Host Your DID Document](#step-3-host-your-did-document)
6. [Step 4: Join a Ring](#step-4-join-a-ring)
7. [Step 5: Submit Posts](#step-5-submit-posts)
8. [Step 6: Display Your Badges](#step-6-display-your-badges)
9. [API Reference](#api-reference)
10. [Code Examples](#code-examples)
11. [Troubleshooting](#troubleshooting)

---

## Concepts

### What is a DID?

A **Decentralized Identifier (DID)** is a globally unique identifier that you control. Unlike usernames on centralized platforms, your DID is tied to your domain and verified cryptographically.

Your DID looks like: `did:web:yourdomain.com`

When RingHub needs to verify you, it fetches your DID document from your website and checks your cryptographic signature.

### What is HTTP Signature Authentication?

Instead of passwords or API keys, ThreadRing uses **HTTP Signatures**. Every request you make is signed with your private key. RingHub verifies the signature using the public key in your DID document.

This means:
- No passwords to leak
- No tokens to expire
- Your identity is tied to your domain
- You control your own keys

### What is a Ring?

Rings are curated communities. When you join a ring:
- You receive a verifiable badge proving membership
- You can submit posts from your site to the ring's feed
- You appear in the ring's member list
- Your profile links back to your personal site

---

## Quick Start

**Prerequisites:**
- A domain with HTTPS (e.g., `yourdomain.com`)
- Ability to host a static JSON file at `/.well-known/did.json`
- Basic programming knowledge (Node.js, Python, or shell scripting)

**Overview:**
1. Generate an Ed25519 keypair
2. Create a DID document with your public key
3. Host the DID document on your site
4. Sign HTTP requests to join rings and submit posts

---

## Step 1: Generate Your Keys

You need an Ed25519 keypair. The private key signs requests; the public key goes in your DID document.

### Using Node.js

```javascript
// generate-keys.js
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Required: configure sha512 for ed25519
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// Generate keypair
const privateKey = ed.utils.randomPrivateKey();
const publicKey = await ed.getPublicKey(privateKey);

console.log('Private Key (keep secret!):');
console.log(Buffer.from(privateKey).toString('base64'));

console.log('\nPublic Key (for DID document):');
console.log(Buffer.from(publicKey).toString('base64'));

// Also output as multibase for DID document
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buffer) {
  let num = BigInt('0x' + Buffer.from(buffer).toString('hex'));
  let encoded = '';
  while (num > 0) {
    encoded = ALPHABET[Number(num % 58n)] + encoded;
    num = num / 58n;
  }
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  return encoded;
}

// Ed25519 multicodec prefix is 0xed01
const multicodecKey = Buffer.concat([Buffer.from([0xed, 0x01]), publicKey]);
const publicKeyMultibase = 'z' + base58Encode(multicodecKey);

console.log('\nPublic Key (multibase format):');
console.log(publicKeyMultibase);
```

Run with:
```bash
npm install @noble/ed25519 @noble/hashes
node generate-keys.js
```

### Using Python

```python
# generate_keys.py
from nacl.signing import SigningKey
import base64
import base58

# Generate keypair
signing_key = SigningKey.generate()
private_key = signing_key.encode()
public_key = signing_key.verify_key.encode()

print("Private Key (keep secret!):")
print(base64.b64encode(private_key).decode())

print("\nPublic Key (for DID document):")
print(base64.b64encode(public_key).decode())

# Multibase format (z + base58btc of multicodec prefix + key)
multicodec_prefix = bytes([0xed, 0x01])
multicodec_key = multicodec_prefix + public_key
public_key_multibase = 'z' + base58.b58encode(multicodec_key).decode()

print("\nPublic Key (multibase format):")
print(public_key_multibase)
```

Run with:
```bash
pip install pynacl base58
python generate_keys.py
```

### Save Your Keys

```
private-key.txt     # KEEP SECRET - never share or commit!
public-key.txt      # Goes in your DID document
```

---

## Step 2: Create Your DID Document

Create a file called `did.json` with this structure:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1"
  ],
  "id": "did:web:yourdomain.com",
  "verificationMethod": [
    {
      "id": "did:web:yourdomain.com#key-1",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:web:yourdomain.com",
      "publicKeyBase64": "YOUR_PUBLIC_KEY_BASE64_HERE"
    }
  ],
  "authentication": [
    "did:web:yourdomain.com#key-1"
  ],
  "assertionMethod": [
    "did:web:yourdomain.com#key-1"
  ],
  "service": [
    {
      "id": "did:web:yourdomain.com#profile",
      "type": "Profile",
      "serviceEndpoint": "https://yourdomain.com/"
    }
  ],
  "name": "Your Display Name",
  "image": "https://yourdomain.com/avatar.jpg"
}
```

### Required Fields

| Field | Description |
|-------|-------------|
| `id` | Your DID: `did:web:yourdomain.com` |
| `verificationMethod` | Array containing your public key(s) |
| `authentication` | References to keys that can sign requests |
| `service[type=Profile]` | URL to your profile page (required) |

### Optional Fields

| Field | Description |
|-------|-------------|
| `name` | Your display name shown in ring member lists |
| `image` | URL to your avatar/profile picture |

### Alternative: Multibase Key Format

Instead of `publicKeyBase64`, you can use `publicKeyMultibase`:

```json
{
  "verificationMethod": [
    {
      "id": "did:web:yourdomain.com#key-1",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:web:yourdomain.com",
      "publicKeyMultibase": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
    }
  ]
}
```

---

## Step 3: Host Your DID Document

Upload your `did.json` to:

```
https://yourdomain.com/.well-known/did.json
```

### Verify It Works

```bash
curl https://yourdomain.com/.well-known/did.json
```

You should see your DID document returned as JSON.

### Content-Type

Ensure your server returns the correct content type:
```
Content-Type: application/json
```

### Alternative Paths

For user-specific DIDs (e.g., `did:web:yourdomain.com:users:alice`), host at:
```
https://yourdomain.com/users/alice/did.json
```

---

## Step 4: Join a Ring

### Find a Ring

Browse available rings (no authentication needed):

```bash
curl https://ringhub.io/trp/rings?visibility=PUBLIC&limit=10
```

Or get trending rings:
```bash
curl https://ringhub.io/trp/rings/trending
```

### Sign Your Request

To join a ring, you must sign your HTTP request. Here's the process:

1. **Build the signing string** (newline-separated):
```
(request-target): post /trp/join
host: ringhub.io
date: Mon, 25 Nov 2024 12:00:00 GMT
digest: sha-256=BASE64_SHA256_OF_BODY
```

2. **Sign with your private key** (Ed25519)

3. **Add the Signature header**:
```
Signature: keyId="did:web:yourdomain.com#key-1",algorithm="ed25519",headers="(request-target) host date digest",signature="BASE64_SIGNATURE"
```

### Join Request

```bash
POST /trp/join HTTP/1.1
Host: ringhub.io
Date: Mon, 25 Nov 2024 12:00:00 GMT
Content-Type: application/json
Digest: sha-256=...
Signature: keyId="did:web:yourdomain.com#key-1",algorithm="ed25519",headers="(request-target) host date digest",signature="..."

{
  "ringSlug": "indie-web"
}
```

### Response

```json
{
  "membership": {
    "id": "uuid",
    "status": "ACTIVE",
    "role": "member",
    "joinedAt": "2024-11-25T12:00:00Z"
  },
  "badge": {
    "id": "badge-uuid",
    "url": "https://ringhub.io/badges/badge-uuid"
  },
  "message": "Successfully joined ring"
}
```

Save the `badge.id` - you'll need it to display your badge!

---

## Step 5: Submit Posts

When you publish a new post on your site, submit it to your rings:

```bash
POST /trp/submit HTTP/1.1
Host: ringhub.io
Date: Mon, 25 Nov 2024 12:00:00 GMT
Content-Type: application/json
Digest: sha-256=...
Signature: keyId="did:web:yourdomain.com#key-1",algorithm="ed25519",headers="(request-target) host date digest",signature="..."

{
  "ringSlug": "indie-web",
  "uri": "https://yourdomain.com/posts/my-new-article",
  "digest": "sha256:abc123...",
  "metadata": {
    "title": "My New Article",
    "publishedAt": "2024-11-25T12:00:00Z"
  }
}
```

The `digest` is a SHA-256 hash of your post content, proving the content hasn't changed.

---

## Step 6: Display Your Badges

Show off your ring memberships with badges on your site!

### Get Your Badges

```bash
curl https://ringhub.io/trp/actors/did:web:yourdomain.com/badges
```

### Standard 88x31 Badge

```html
<!-- In your sidebar or footer -->
<a href="https://ringhub.io/rings/indie-web">
  <img src="https://ringhub.io/badges/YOUR_BADGE_ID.png"
       alt="Member of indie-web ring"
       width="88" height="31">
</a>
```

### High-Resolution Badge (352x124)

```html
<a href="https://ringhub.io/rings/indie-web">
  <img src="https://ringhub.io/badges/YOUR_BADGE_ID.png?size=hd"
       alt="Member of indie-web ring"
       width="352" height="124">
</a>
```

### Multiple Badges Layout

```html
<div class="ring-badges">
  <a href="https://ringhub.io/rings/indie-web">
    <img src="https://ringhub.io/badges/badge-1.png" width="88" height="31" alt="indie-web">
  </a>
  <a href="https://ringhub.io/rings/webdev">
    <img src="https://ringhub.io/badges/badge-2.png" width="88" height="31" alt="webdev">
  </a>
  <a href="https://ringhub.io/rings/personal-sites">
    <img src="https://ringhub.io/badges/badge-3.png" width="88" height="31" alt="personal-sites">
  </a>
</div>

<style>
.ring-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ring-badges img {
  image-rendering: pixelated; /* crisp edges for 88x31 */
}
</style>
```

---

## API Reference

### Public Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/trp/rings` | List/search rings |
| GET | `/trp/rings/{slug}` | Get ring details |
| GET | `/trp/rings/{slug}/feed` | Get ring feed |
| GET | `/trp/rings/trending` | Get trending rings |
| GET | `/trp/badges/{id}` | Get badge details |
| GET | `/trp/actors/{did}/badges` | Get actor's badges |

### Authenticated Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/trp/join` | Join a ring |
| POST | `/trp/leave` | Leave a ring |
| POST | `/trp/submit` | Submit content to ring |

---

## Code Examples

### JavaScript: Complete Signing Example

```javascript
// threadring-client.js
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export class ThreadRingClient {
  constructor({ hubUrl, did, privateKey }) {
    this.hubUrl = hubUrl;
    this.did = did;
    this.keyId = `${did}#key-1`;
    this.privateKey = Buffer.from(privateKey, 'base64');
  }

  async signRequest(method, path, body = null) {
    const host = new URL(this.hubUrl).host;
    const date = new Date().toUTCString();
    const headers = { host, date };

    // Build signing string
    const lines = [`(request-target): ${method.toLowerCase()} ${path}`];
    lines.push(`host: ${host}`);
    lines.push(`date: ${date}`);

    if (body) {
      const bodyStr = JSON.stringify(body);
      const digest = `sha-256=${Buffer.from(sha256(bodyStr)).toString('base64')}`;
      headers.digest = digest;
      headers['content-type'] = 'application/json';
      lines.push(`digest: ${digest}`);
    }

    const signingString = lines.join('\n');
    const headersParam = body
      ? '(request-target) host date digest'
      : '(request-target) host date';

    // Sign
    const messageBytes = new TextEncoder().encode(signingString);
    const signatureBytes = await ed.sign(messageBytes, this.privateKey);
    const signature = Buffer.from(signatureBytes).toString('base64');

    // Build signature header
    headers.signature = [
      `keyId="${this.keyId}"`,
      'algorithm="ed25519"',
      `headers="${headersParam}"`,
      `signature="${signature}"`
    ].join(',');

    return headers;
  }

  async join(ringSlug) {
    const path = '/trp/join';
    const body = { ringSlug };
    const headers = await this.signRequest('POST', path, body);

    const response = await fetch(`${this.hubUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    return response.json();
  }

  async submit(ringSlug, uri, metadata = {}) {
    const path = '/trp/submit';
    const body = { ringSlug, uri, metadata };
    const headers = await this.signRequest('POST', path, body);

    const response = await fetch(`${this.hubUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    return response.json();
  }
}

// Usage:
const client = new ThreadRingClient({
  hubUrl: 'https://ringhub.io',
  did: 'did:web:yourdomain.com',
  privateKey: process.env.THREADRING_PRIVATE_KEY
});

await client.join('indie-web');
await client.submit('indie-web', 'https://yourdomain.com/posts/hello-world');
```

### Python: Complete Signing Example

```python
# threadring_client.py
import hashlib
import base64
import json
from datetime import datetime
from urllib.parse import urlparse
from nacl.signing import SigningKey

class ThreadRingClient:
    def __init__(self, hub_url, did, private_key_base64):
        self.hub_url = hub_url
        self.did = did
        self.key_id = f"{did}#key-1"
        self.signing_key = SigningKey(base64.b64decode(private_key_base64))

    def _sign_request(self, method, path, body=None):
        host = urlparse(self.hub_url).netloc
        date = datetime.utcnow().strftime('%a, %d %b %Y %H:%M:%S GMT')

        headers = {'Host': host, 'Date': date}

        # Build signing string
        lines = [f'(request-target): {method.lower()} {path}']
        lines.append(f'host: {host}')
        lines.append(f'date: {date}')

        if body:
            body_str = json.dumps(body)
            digest_bytes = hashlib.sha256(body_str.encode()).digest()
            digest = f'sha-256={base64.b64encode(digest_bytes).decode()}'
            headers['Digest'] = digest
            headers['Content-Type'] = 'application/json'
            lines.append(f'digest: {digest}')

        signing_string = '\n'.join(lines)
        headers_param = '(request-target) host date digest' if body else '(request-target) host date'

        # Sign
        signed = self.signing_key.sign(signing_string.encode())
        signature = base64.b64encode(signed.signature).decode()

        # Build signature header
        sig_parts = [
            f'keyId="{self.key_id}"',
            'algorithm="ed25519"',
            f'headers="{headers_param}"',
            f'signature="{signature}"'
        ]
        headers['Signature'] = ','.join(sig_parts)

        return headers

    def join(self, ring_slug):
        import requests
        path = '/trp/join'
        body = {'ringSlug': ring_slug}
        headers = self._sign_request('POST', path, body)

        response = requests.post(
            f'{self.hub_url}{path}',
            headers=headers,
            json=body
        )
        return response.json()

    def submit(self, ring_slug, uri, metadata=None):
        import requests
        path = '/trp/submit'
        body = {'ringSlug': ring_slug, 'uri': uri, 'metadata': metadata or {}}
        headers = self._sign_request('POST', path, body)

        response = requests.post(
            f'{self.hub_url}{path}',
            headers=headers,
            json=body
        )
        return response.json()

# Usage:
import os

client = ThreadRingClient(
    hub_url='https://ringhub.io',
    did='did:web:yourdomain.com',
    private_key_base64=os.environ['THREADRING_PRIVATE_KEY']
)

result = client.join('indie-web')
print(result)
```

### curl: Testing with Shell Script

```bash
#!/bin/bash
# sign-request.sh - Sign and send a request to RingHub

# Configuration
HUB_URL="https://ringhub.io"
DID="did:web:yourdomain.com"
KEY_ID="${DID}#key-1"
PRIVATE_KEY_FILE="private-key.txt"

# Request details
METHOD="POST"
PATH="/trp/join"
BODY='{"ringSlug":"indie-web"}'

# Generate headers
HOST="ringhub.io"
DATE=$(date -u +"%a, %d %b %Y %H:%M:%S GMT")
DIGEST="sha-256=$(echo -n "$BODY" | openssl dgst -sha256 -binary | base64)"

# Build signing string
SIGNING_STRING="(request-target): ${METHOD,,} $PATH
host: $HOST
date: $DATE
digest: $DIGEST"

echo "Signing string:"
echo "$SIGNING_STRING"
echo ""

# Sign (requires openssl with Ed25519 support, or use a helper tool)
# Note: OpenSSL Ed25519 signing requires specific key format
# For testing, you may need to use a Node.js or Python helper

# Example with Node.js helper:
SIGNATURE=$(node -e "
const ed = require('@noble/ed25519');
const fs = require('fs');
const key = Buffer.from(fs.readFileSync('$PRIVATE_KEY_FILE', 'utf8').trim(), 'base64');
const msg = Buffer.from(\`$SIGNING_STRING\`);
ed.sign(msg, key).then(sig => console.log(Buffer.from(sig).toString('base64')));
")

# Build signature header
SIG_HEADER="keyId=\"$KEY_ID\",algorithm=\"ed25519\",headers=\"(request-target) host date digest\",signature=\"$SIGNATURE\""

# Make request
curl -X $METHOD "$HUB_URL$PATH" \
  -H "Host: $HOST" \
  -H "Date: $DATE" \
  -H "Content-Type: application/json" \
  -H "Digest: $DIGEST" \
  -H "Signature: $SIG_HEADER" \
  -d "$BODY"
```

---

## Troubleshooting

### "Unknown key" Error

**Problem:** RingHub can't find your public key.

**Solutions:**
1. Verify your DID document is accessible:
   ```bash
   curl https://yourdomain.com/.well-known/did.json
   ```
2. Check the `keyId` in your signature matches your DID document
3. Ensure your public key is correctly base64-encoded

### "Invalid signature" Error

**Problem:** The signature doesn't verify.

**Checklist:**
1. **Signing string format** - Each line must end with `\n` (except the last)
2. **Header order** - Must match the `headers` parameter exactly
3. **Case sensitivity** - `(request-target)` must be lowercase
4. **Date format** - Use RFC 2822: `Mon, 25 Nov 2024 12:00:00 GMT`
5. **Digest calculation** - Must be SHA-256 of the exact request body bytes

### "Signature expired" Error

**Problem:** The request took too long or clock skew.

**Solutions:**
1. Ensure your server's clock is synchronized (use NTP)
2. Generate the `date` header immediately before sending
3. Signature validity window is 5 minutes

### DID Document Not Found

**Problem:** 404 when fetching DID document.

**Solutions:**
1. File must be at `/.well-known/did.json`
2. Server must return `Content-Type: application/json`
3. HTTPS is required (no HTTP)

### Badge Not Displaying

**Problem:** Badge image returns 404.

**Solutions:**
1. Use the badge ID from your join response
2. URL format: `https://ringhub.io/badges/{badge-id}.png`
3. Check if your membership is still active

---

## Security Best Practices

1. **Never share your private key** - Treat it like a password
2. **Use environment variables** - Don't hardcode keys in source code
3. **Rotate keys periodically** - Update your DID document with new keys
4. **HTTPS only** - Your DID document and profile must use HTTPS
5. **Verify signatures locally** - Test your signing code before sending requests

---

## Getting Help

- **API Documentation:** See [RING_HUB_API_SPEC.md](../RING_HUB_API_SPEC.md)
- **Issues:** Report problems on GitHub
- **Ring Discovery:** Browse rings at `https://ringhub.io/trp/rings`

---

## What's Next?

After setting up your personal site:

1. **Join multiple rings** - Find communities that match your interests
2. **Submit your posts** - Share your content with ring members
3. **Display badges** - Show your memberships on your site
4. **Create a ring** - Start your own community

Welcome to the ThreadRing network!
