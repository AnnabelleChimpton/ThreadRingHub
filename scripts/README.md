# Production Reset Script

## ⚠️ EXTREMELY DANGEROUS SCRIPT ⚠️

The `reset-production.sh` script will **PERMANENTLY DELETE ALL DATA** in your production database and recreate a fresh root ThreadRing.

## What it does

1. **Clears Redis cache** (sessions, cached data)
2. **Drops all database tables** (complete data wipe)
3. **Recreates the database schema** from Prisma schema
4. **Generates a fresh Prisma client**
5. **Creates the root ThreadRing** (default: "spool")
6. **Creates default roles** (owner, moderator, member)
7. **Restarts services** (API and Redis) and verifies setup

## Required Environment Variables

Before running, ensure these are set:

- `DATABASE_URL` - Your production PostgreSQL connection string
- `INSTANCE_DID` - Your Ring Hub's DID (will be the owner of the root ring)
- `RING_HUB_URL` - Your Ring Hub's public URL (for badge generation)
- `ROOT_RING_SLUG` - Slug for root ring (optional, defaults to "spool")

## Recommended Environment Variables

- `RING_HUB_PRIVATE_KEY` - Ed25519 private key in PEM format for badge signing
  - ⚠️ **Critical**: Without this, keys are generated at runtime and badges become invalid on restart
  - Generate with: `openssl genpkey -algorithm Ed25519 -out private.pem`

## Usage

```bash
# Run from the project root directory
./scripts/reset-production.sh
```

The script requires **three confirmations** to prevent accidental execution:

1. Type: `DELETE ALL DATA`
2. Type: `I UNDERSTAND THIS IS IRREVERSIBLE`  
3. Type: `RESET PRODUCTION NOW`

## What gets deleted

### PostgreSQL Database
- **All rings** and their metadata
- **All user memberships** and badges
- **All posts** and content references
- **All audit logs** and history
- **All authentication data** and actor records
- **All challenges, blocks, invitations**

### Redis Cache
- **All session data** and user sessions
- **All cached API responses** and computed data
- **All rate limiting counters** and temporary data
- **All queued background jobs** (if using Redis for queues)

## After running

You'll have a completely fresh Ring Hub with:

- One root ThreadRing (slug: your `ROOT_RING_SLUG`)
- Default role structure (owner/moderator/member)
- Clean database ready for new users and content

## Post-Reset Checklist

**Critical additional steps required:**

1. **🔑 Set up persistent cryptographic keys:**
   ```bash
   # Generate Ed25519 keypair if you don't have one
   openssl genpkey -algorithm Ed25519 -out ring-hub-private.pem
   openssl pkey -in ring-hub-private.pem -pubout -out ring-hub-public.pem
   
   # Set environment variable
   export RING_HUB_PRIVATE_KEY="$(cat ring-hub-private.pem)"
   ```

2. **🆔 Set up DID document endpoints:**
   - Implement `GET /.well-known/did.json` (returns instance DID document)
   - Implement `GET /users/{hash}/did.json` (returns user DID documents)
   - Include your public key in DID documents for badge verification

3. **🔄 Restart services** after setting RING_HUB_PRIVATE_KEY:
   ```bash
   docker-compose restart hub-api
   ```

4. **✅ Verify badge functionality:**
   - Create a test account and join the root ring
   - Check that badges are generated and verifiable
   - Confirm badges survive service restarts

## Recovery

**There is no recovery from this script.** Make sure you have:

- Database backups if you need to revert
- Exported any critical data beforehand
- Full understanding that this is irreversible

## Testing

For safety, test this script in a staging environment first with the same database schema and Docker setup.