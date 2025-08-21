# Ring Hub

A neutral, protocol-first service for hosting and federating **ThreadRings** across the web.  
Ring Hub allows **personal blogs, CMSs, fediverse actors, and ThreadStead instances** to join and maintain ThreadRings without being tied to a single platform.

## 🎯 Vision

Create a decentralized ThreadRing protocol that allows any website, blog, or platform to participate in ThreadRings without being locked into a single platform.

### Core Principles
- **Protocol-first design** (not platform-specific)
- **Minimal data storage** (metadata and references only)
- **Cryptographically secure** (HTTP signatures)
- **Federation-ready** from day one
- **Performance at scale**

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm 9+
- Docker and Docker Compose
- Git

### Local Development Setup

```bash
# Clone and enter directory
git clone https://github.com/yourusername/ring-hub.git
cd ring-hub

# Install dependencies
npm install

# Start development environment
docker-compose up -d

# Run database migrations
npm run db:migrate

# Start development server
npm run dev

# API will be available at http://localhost:3000
# Swagger docs at http://localhost:3000/docs
```

## 📁 Repository Structure

```
ring-hub/
├── apps/
│   ├── hub-api/           # Main Fastify API service
│   └── hub-admin/         # Admin dashboard (future)
├── packages/
│   ├── trp-schemas/       # Shared Zod schemas and types
│   ├── trp-client/        # TypeScript SDK for Ring Hub
│   └── trp-cli/           # CLI tools for developers
├── infra/
│   ├── docker/            # Docker configurations
│   └── k8s/               # Kubernetes manifests (production)
├── docs/
│   ├── api/               # API documentation
│   ├── integration/       # Platform integration guides
│   └── federation/        # Federation protocol specs
├── scripts/               # Development and deployment scripts
└── tests/                 # Integration and E2E tests
```

## 🔧 Development

### Available Scripts

```bash
# Development
npm run dev              # Start all services in development mode
npm run dev:api          # Start only the API service
npm run dev:watch        # Start with file watching enabled

# Database
npm run db:migrate       # Run database migrations
npm run db:seed          # Seed development data
npm run db:reset         # Reset database (destructive)

# Testing
npm test                 # Run all tests
npm run test:unit        # Run unit tests only
npm run test:integration # Run integration tests
npm run test:e2e         # Run end-to-end tests

# Linting & Type Checking
npm run lint             # Run ESLint
npm run lint:fix         # Fix auto-fixable lint issues
npm run typecheck        # Run TypeScript type checking

# Building
npm run build            # Build all packages
npm run build:api        # Build API service only
npm run build:sdk        # Build TypeScript SDK

# Docker
npm run docker:build     # Build Docker images
npm run docker:up        # Start all services with Docker
npm run docker:down      # Stop all Docker services
```

## 🏗️ Architecture

### Core Components

- **hub-api**: Fastify-based API service implementing the ThreadRing protocol
- **trp-schemas**: Shared Zod schemas for request/response validation
- **trp-client**: TypeScript SDK for integrating with Ring Hub
- **trp-cli**: Command-line tools for developers and administrators

### Technology Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Framework**: Fastify with OpenAPI integration
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis for performance optimization
- **Authentication**: HTTP Signatures (Ed25519)
- **Identity**: Decentralized Identifiers (DIDs)
- **Testing**: Jest + Supertest
- **Containerization**: Docker + Docker Compose

## 🔐 Security

Ring Hub implements comprehensive security measures:

- **HTTP Signatures**: All write operations require Ed25519 signed requests
- **DID Resolution**: Support for `did:web` and `did:key` identifiers  
- **Replay Protection**: Nonce and timestamp validation
- **Rate Limiting**: Per-actor and per-IP limits
- **Input Validation**: Comprehensive request validation with Zod schemas
- **Audit Logging**: Immutable audit trails for all moderation actions

## 🌐 API Overview

### Core Endpoints

```
GET    /.well-known/threadrings     # Node capabilities
GET    /trp/rings                   # List/search rings
POST   /trp/rings                   # Create ring
GET    /trp/rings/{slug}            # Get ring descriptor  
PUT    /trp/rings/{slug}            # Update ring
GET    /trp/rings/{slug}/feed       # Get ring feed
GET    /trp/rings/{slug}/members    # List members
POST   /trp/join                    # Join ring
POST   /trp/submit                  # Submit PostRef
POST   /trp/curate                  # Moderate content
POST   /trp/fork                    # Fork ring
```

See [API Documentation](./docs/api/README.md) for complete details.

## 🤝 Integration

### For Platform Developers

```bash
# Install the SDK
npm install @ringhub/trp-client

# Use in your application
import { RingHubClient } from '@ringhub/trp-client';

const client = new RingHubClient({
  endpoint: 'https://ringhub.example.org',
  did: 'did:web:yourdomain.com',
  privateKey: yourPrivateKey
});

// Join a ring
const badge = await client.joinRing('sustainable-tech');
```

### Integration Guides
- [WordPress Plugin](./docs/integration/wordpress.md)
- [Ghost Theme](./docs/integration/ghost.md) 
- [Static Sites (Hugo/Jekyll)](./docs/integration/static-sites.md)
- [Next.js Integration](./docs/integration/nextjs.md)

## 🧪 Testing

Ring Hub includes comprehensive testing:

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suites
npm run test:unit        # Fast unit tests
npm run test:integration # API integration tests
npm run test:federation  # Cross-instance tests
npm run test:security    # Security validation tests
```

## 🚀 Deployment

### Production Deployment

Ring Hub is designed for scalable production deployment:

```bash
# Build production images
npm run docker:build:prod

# Deploy with Kubernetes
kubectl apply -f infra/k8s/

# Or deploy with Docker Compose
docker-compose -f docker-compose.prod.yml up -d
```

### Environment Variables

Required environment variables:

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/ringhub
REDIS_URL=redis://localhost:6379

# Security  
JWT_SECRET=your-jwt-secret
SIGNING_KEY_PATH=/path/to/signing-key.pem

# API Configuration
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Federation
INSTANCE_DID=did:web:yourdomain.com
FEDERATION_ENABLED=true
```

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

### Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass (`npm test`)
6. Commit with clear messages (`git commit -m 'Add amazing feature'`)
7. Push to your fork (`git push origin feature/amazing-feature`)
8. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## 🔗 Links

- **Documentation**: [docs.ringhub.org](https://docs.ringhub.org)
- **API Reference**: [api.ringhub.org](https://api.ringhub.org)  
- **Community Discord**: [discord.gg/ringhub](https://discord.gg/ringhub)
- **ThreadRing Protocol**: [threadring.org](https://threadring.org)

## 🗺️ Roadmap

- **Phase 1** (Weeks 1-2): Core infrastructure and API framework
- **Phase 2** (Weeks 3-4): Security, authentication, and core ring operations  
- **Phase 3** (Weeks 5-6): Membership system and content moderation
- **Phase 4** (Weeks 7-9): Federation and ActivityPub integration
- **Phase 5** (Week 10): Production deployment and external platform support

See [ROADMAP.md](./ROADMAP.md) for detailed plans and milestones.

---

**Ring Hub**: Building communities that outlast platforms. 🌐