# Contributing to Ring Hub

Thank you for your interest in contributing to Ring Hub! This document provides guidelines and information for contributors.

## 🎯 Project Vision

Ring Hub is building a decentralized protocol for cross-platform communities. Our goal is to enable any website, blog, or platform to participate in ThreadRings without platform lock-in.

## 🤝 Code of Conduct

We are committed to providing a welcoming and inclusive experience for everyone. Please read and follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## 🚀 Getting Started

### Development Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/yourusername/ring-hub.git
   cd ring-hub
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment**
   ```bash
   cp .env.example .env
   # Edit .env with your local configuration
   ```

4. **Start development environment**
   ```bash
   docker-compose up -d  # Start PostgreSQL and Redis
   npm run db:migrate    # Run database migrations
   npm run dev          # Start development server
   ```

5. **Verify setup**
   ```bash
   curl http://localhost:3000/health
   # Should return: {"status": "ok"}
   ```

### Project Structure

- `apps/hub-api/` - Main Fastify API service
- `packages/trp-schemas/` - Shared Zod schemas and types
- `packages/trp-client/` - TypeScript SDK
- `packages/trp-cli/` - Command-line tools
- `docs/` - Documentation and guides
- `tests/` - Integration and E2E tests

## 📋 Contribution Types

We welcome various types of contributions:

### 🐛 Bug Reports
- Use GitHub Issues with the "bug" label
- Include detailed reproduction steps
- Provide environment information
- Add relevant logs or error messages

### ✨ Feature Requests
- Use GitHub Issues with the "enhancement" label
- Explain the use case and expected behavior
- Consider if it fits the protocol-first design philosophy

### 📚 Documentation
- Improve API documentation
- Add platform integration guides
- Create tutorials and examples
- Fix typos and clarify explanations

### 🔧 Code Contributions
- Bug fixes
- New features
- Performance improvements
- Test coverage improvements

## 🔄 Development Workflow

### 1. Create a Branch
```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-number-short-description
```

### 2. Make Changes
- Follow the coding standards (see below)
- Add tests for new functionality
- Update documentation as needed
- Ensure all tests pass

### 3. Test Your Changes
```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:e2e

# Check code quality
npm run lint
npm run typecheck
```

### 4. Commit Your Changes
We use conventional commits:
```bash
git commit -m "feat: add genealogy tree visualization"
git commit -m "fix: resolve authentication token expiry issue"
git commit -m "docs: update API authentication examples"
```

Commit types:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

### 5. Push and Create Pull Request
```bash
git push origin your-branch-name
```

Then create a Pull Request on GitHub with:
- Clear description of changes
- Reference to related issues
- Screenshots for UI changes
- Breaking changes noted

## 🎨 Coding Standards

### TypeScript
- Use strict TypeScript configuration
- Provide explicit types for function parameters and return values
- Use `unknown` instead of `any` when possible
- Prefer type unions over enums when appropriate

### Code Style
- Use Prettier for formatting (runs automatically)
- Follow ESLint rules (check with `npm run lint`)
- Use descriptive variable and function names
- Keep functions small and focused (max 50 lines)
- Add JSDoc comments for public APIs

### API Design
- Follow OpenAPI specification
- Use consistent naming conventions
- Validate all inputs with Zod schemas
- Return appropriate HTTP status codes
- Include detailed error messages

### Database
- Use Prisma for database operations
- Write migrations for schema changes
- Index frequently queried columns
- Use transactions for multi-step operations

### Testing
- Write unit tests for business logic
- Add integration tests for API endpoints
- Include security tests for authentication
- Test error handling scenarios
- Aim for 80%+ code coverage

## 🔒 Security Guidelines

### Authentication
- All write operations require HTTP signatures
- Validate DID ownership for sensitive operations
- Use rate limiting to prevent abuse
- Log security-relevant events

### Input Validation
- Validate all inputs with Zod schemas
- Sanitize user-provided content
- Check authorization for all operations
- Prevent injection attacks

### Secrets Management
- Never commit secrets to the repository
- Use environment variables for configuration
- Rotate keys regularly
- Use secure random generation

## 🧪 Testing Guidelines

### Test Structure
```typescript
describe('Feature Name', () => {
  beforeEach(async () => {
    // Set up test environment
  });

  afterEach(async () => {
    // Clean up
  });

  it('should handle normal case', async () => {
    // Arrange
    const input = createTestInput();
    
    // Act
    const result = await functionUnderTest(input);
    
    // Assert
    expect(result).toEqual(expectedOutput);
  });

  it('should handle error case', async () => {
    // Test error scenarios
  });
});
```

### Test Data
- Use factories for creating test data
- Clean up test data after each test
- Use separate test database
- Mock external dependencies

## 📚 Documentation Standards

### API Documentation
- Document all endpoints in OpenAPI spec
- Include request/response examples
- Explain error conditions
- Add integration examples

### Code Documentation
- Use JSDoc for public functions
- Include parameter and return type descriptions
- Add usage examples for complex functions
- Document design decisions

### Integration Guides
- Provide step-by-step instructions
- Include complete code examples
- Test examples with real platforms
- Keep guides updated with changes

## 🎯 Protocol Considerations

When contributing to Ring Hub, keep these protocol principles in mind:

### Decentralization
- Avoid vendor lock-in
- Support multiple implementations
- Enable cross-platform participation
- Maintain protocol neutrality

### Privacy
- Never widen content visibility
- Respect user privacy settings
- Store minimal necessary data
- Enable user data portability

### Federation
- Design for cross-instance compatibility
- Support ActivityPub standards
- Enable distributed governance
- Plan for protocol evolution

## 🏷️ Release Process

1. **Version Bumping**
   - Use semantic versioning (SemVer)
   - Update CHANGELOG.md
   - Tag releases with `v` prefix

2. **Release Notes**
   - Highlight breaking changes
   - List new features
   - Include migration guides
   - Thank contributors

3. **Deployment**
   - Test in staging environment
   - Deploy to production
   - Monitor for issues
   - Communicate to community

## 📞 Getting Help

### Community Channels
- **Discord**: [discord.gg/ringhub](https://discord.gg/ringhub)
- **GitHub Discussions**: For design discussions
- **GitHub Issues**: For bug reports and feature requests

### Maintainer Contact
- For security issues: security@ringhub.org
- For general questions: hello@ringhub.org

### Office Hours
We hold weekly community calls:
- **When**: Fridays at 3 PM UTC
- **Where**: Discord voice channel
- **What**: Discuss contributions, answer questions, plan features

## 🏆 Recognition

Contributors are recognized in:
- CONTRIBUTORS.md file
- Release notes
- GitHub contributor graphs
- Community highlights

## 📄 License

By contributing to Ring Hub, you agree that your contributions will be licensed under the MIT License.

---

Thank you for helping make Ring Hub a success! 🌐