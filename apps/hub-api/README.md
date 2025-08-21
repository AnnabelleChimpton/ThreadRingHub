# Ring Hub API Documentation

This directory contains comprehensive documentation for the Ring Hub ThreadRing Protocol (TRP) API.

## 📁 Documentation Structure

```
docs/api/
├── README.md              # This file - API overview
├── openapi.yaml           # Complete OpenAPI 3.0 specification
├── authentication.md      # HTTP signature authentication guide
├── rate-limiting.md       # Rate limiting and quotas
├── errors.md             # Error codes and handling
├── webhooks.md           # Webhook events and payloads
├── examples/             # Request/response examples
│   ├── rings.md         # Ring management examples
│   ├── membership.md    # Join/leave examples
│   ├── content.md       # PostRef submission examples
│   └── moderation.md    # Curation examples
├── integration/          # Platform integration guides
│   ├── wordpress.md     # WordPress plugin guide
│   ├── ghost.md         # Ghost integration guide
│   ├── static-sites.md  # Hugo/Jekyll integration
│   └── nextjs.md        # Next.js integration guide
└── federation/           # Federation and ActivityPub
    ├── protocol.md      # TRP federation protocol
    ├── activitypub.md   # ActivityPub mapping
    └── discovery.md     # Instance discovery
```

## 🚀 Quick Start

### Base URL
```
Production:  https://api.ringhub.org
Staging:     https://staging-api.ringhub.org
Development: http://localhost:3000
```

### Authentication
All write operations require HTTP signature authentication using Ed25519 keys:

```http
POST /trp/rings
Host: api.ringhub.org
Date: Tue, 07 Nov 2023 12:00:00 GMT
Signature: keyId="did:web:example.com#main-key",algorithm="ed25519",headers="(request-target) host date digest",signature="..."
Content-Type: application/json
```

See [Authentication Guide](./authentication.md) for complete details.

## 🔗 Core Endpoints

### Node Information
```http
GET /.well-known/threadrings
```
Returns node capabilities and supported features.

### Ring Management
```http
GET    /trp/rings              # List/search rings
POST   /trp/rings              # Create new ring
GET    /trp/rings/{slug}       # Get ring descriptor
PUT    /trp/rings/{slug}       # Update ring (owner only)
DELETE /trp/rings/{slug}       # Delete ring (owner only)
```

### Ring Discovery
```http
GET /trp/rings/trending        # Get trending rings
GET /trp/rings/{slug}/lineage  # Get genealogy tree
```

### Membership
```http
POST /trp/join                 # Join a ring
POST /trp/leave                # Leave a ring
GET  /trp/rings/{slug}/members # List ring members
PUT  /trp/rings/{slug}/members/{did} # Update member role
```

### Content
```http
POST /trp/submit               # Submit PostRef to ring
GET  /trp/rings/{slug}/feed    # Get ring feed
GET  /trp/rings/{slug}/queue   # Get moderation queue
POST /trp/curate               # Moderate content
```

### Community Evolution
```http
POST /trp/fork                 # Fork a ring
GET  /trp/rings/{slug}/audit   # Get audit log
```

## 📊 Data Formats

### Ring Descriptor
```json
{
  "@type": "RingDescriptor",
  "id": "https://api.ringhub.org/trp/rings/sustainable-tech",
  "name": "Sustainable Technology",
  "summary": "Community focused on sustainable and green technology innovations",
  "icon": "https://example.com/icons/sustainable-tech.png",
  "policy": {
    "membership": "open",
    "moderation": "curated",
    "visibility": "public"
  },
  "roles": {
    "owners": ["did:web:alice.example.com"],
    "curators": ["did:web:bob.example.com", "did:web:carol.example.com"]
  },
  "createdAt": "2023-11-07T12:00:00Z",
  "parent": null,
  "ancestors": []
}
```

### PostRef (Content Reference)
```json
{
  "@type": "PostRef",
  "ring": "https://api.ringhub.org/trp/rings/sustainable-tech",
  "post": {
    "id": "https://alice.example.com/posts/solar-breakthrough",
    "digest": "sha256:abc123...",
    "author": "did:web:alice.example.com",
    "visibility": "public"
  },
  "insertedAt": "2023-11-07T15:30:00Z",
  "decision": "accepted",
  "sig": "ed25519:signature..."
}
```

### Membership Badge
```json
{
  "@type": "TRPBadge",
  "label": "Member of Sustainable Technology",
  "icon": "https://api.ringhub.org/badges/sustainable-tech-member.png",
  "member": "did:web:alice.example.com",
  "ring": "https://api.ringhub.org/trp/rings/sustainable-tech",
  "issuer": "https://api.ringhub.org",
  "issuedAt": "2023-11-07T12:00:00Z",
  "proof": {
    "type": "Ed25519Signature2020",
    "sig": "ed25519:signature...",
    "payloadHash": "sha256:hash..."
  }
}
```

## 🔐 Security

### HTTP Signatures
All write operations require cryptographic signatures using Ed25519 keys. The signature covers:
- Request method and path
- Host header
- Date header (must be within 5 minutes)
- Request body digest (for POST/PUT)

### Rate Limiting
- **Authenticated requests**: 1000 requests per hour per DID
- **Unauthenticated requests**: 100 requests per hour per IP
- **Bulk operations**: Special limits for federation

### Input Validation
All requests are validated against JSON schemas. Invalid requests return `400 Bad Request` with detailed error messages.

## 🌐 Federation

Ring Hub supports federation through:
- **ActivityPub Groups**: Rings can be followed as ActivityPub Groups
- **Cross-Instance Membership**: Join rings hosted on other Ring Hub instances
- **Distributed Genealogy**: Fork trees span multiple instances

See [Federation Documentation](./federation/) for details.

## 📚 SDKs and Tools

### TypeScript SDK
```bash
npm install @ringhub/trp-client
```

```typescript
import { RingHubClient } from '@ringhub/trp-client';

const client = new RingHubClient({
  endpoint: 'https://api.ringhub.org',
  did: 'did:web:yourdomain.com',
  privateKey: yourEd25519PrivateKey
});

// Create a ring
const ring = await client.createRing({
  name: 'My Community',
  summary: 'A great community for sharing ideas',
  policy: { membership: 'open', moderation: 'curated' }
});
```

### CLI Tools
```bash
npm install -g @ringhub/trp-cli

# Initialize configuration
trp init --endpoint https://api.ringhub.org --did did:web:yourdomain.com

# Create a ring
trp ring create "My Community" --summary "A great community" --open

# Join a ring
trp join sustainable-tech

# Submit content
trp submit https://yourblog.com/post/123 sustainable-tech
```

## ❓ Support

- **API Issues**: [GitHub Issues](https://github.com/yourusername/ring-hub/issues)
- **Integration Help**: [Community Discord](https://discord.gg/ringhub)
- **Documentation**: [docs.ringhub.org](https://docs.ringhub.org)
- **Status Page**: [status.ringhub.org](https://status.ringhub.org)

## 📄 License

The Ring Hub API is open source under the MIT License. The protocol specification is freely implementable by any platform or service.