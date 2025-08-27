#!/bin/bash

# Reset Production Database and Recreate Root ThreadRing
# WARNING: This script will PERMANENTLY DELETE ALL DATA in the production database
# Use with extreme caution - there is no undo!

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${RED}⚠️  DANGER: PRODUCTION DATABASE RESET ⚠️${NC}"
echo -e "${RED}This script will PERMANENTLY DELETE ALL DATA in the production database!${NC}"
echo ""
echo "This includes:"
echo "- All rings and their data"
echo "- All user memberships and badges" 
echo "- All posts and content references"
echo "- All audit logs and history"
echo "- All authentication data"
echo ""

# Triple confirmation required
echo -e "${YELLOW}Type 'DELETE ALL DATA' to confirm you want to proceed:${NC}"
read -r confirmation1
if [ "$confirmation1" != "DELETE ALL DATA" ]; then
    echo "Confirmation failed. Aborting."
    exit 1
fi

echo -e "${YELLOW}Type 'I UNDERSTAND THIS IS IRREVERSIBLE' to confirm:${NC}"
read -r confirmation2
if [ "$confirmation2" != "I UNDERSTAND THIS IS IRREVERSIBLE" ]; then
    echo "Confirmation failed. Aborting."
    exit 1
fi

echo -e "${YELLOW}Final confirmation - type 'RESET PRODUCTION NOW' to proceed:${NC}"
read -r confirmation3
if [ "$confirmation3" != "RESET PRODUCTION NOW" ]; then
    echo "Confirmation failed. Aborting."
    exit 1
fi

echo ""
echo -e "${GREEN}✓ All confirmations received. Beginning database reset...${NC}"

# Check if we're in production environment
if [ "${NODE_ENV}" != "production" ] && [ "${ENVIRONMENT}" != "production" ]; then
    echo -e "${YELLOW}Warning: NODE_ENV is not set to 'production'. Proceeding anyway...${NC}"
fi

# Ensure required environment variables are set
if [ -z "${DATABASE_URL}" ]; then
    echo -e "${RED}Error: DATABASE_URL environment variable is not set${NC}"
    exit 1
fi

if [ -z "${ROOT_RING_SLUG}" ]; then
    echo -e "${YELLOW}Warning: ROOT_RING_SLUG not set, defaulting to 'spool'${NC}"
    ROOT_RING_SLUG="spool"
fi

if [ -z "${INSTANCE_DID}" ]; then
    echo -e "${RED}Error: INSTANCE_DID environment variable is not set${NC}"
    exit 1
fi

if [ -z "${RING_HUB_URL}" ]; then
    echo -e "${RED}Error: RING_HUB_URL environment variable is not set${NC}"
    exit 1
fi

if [ -z "${RING_HUB_PRIVATE_KEY}" ]; then
    echo -e "${YELLOW}Warning: RING_HUB_PRIVATE_KEY not set - badges will use runtime-generated keys${NC}"
    echo -e "${YELLOW}This means all badges will become invalid if the service restarts!${NC}"
    echo -e "${YELLOW}Consider setting a persistent Ed25519 private key for production${NC}"
fi

echo "Using configuration:"
echo "- Database: ${DATABASE_URL}"
echo "- Root ring slug: ${ROOT_RING_SLUG}"
echo "- Instance DID: ${INSTANCE_DID}"
echo "- Ring Hub URL: ${RING_HUB_URL}"
echo "- Private key configured: $([ -n "${RING_HUB_PRIVATE_KEY}" ] && echo "Yes" || echo "No (will generate at runtime)")"
echo ""

# Step 1: Clear Redis cache and sessions
echo -e "${GREEN}Step 1: Clearing Redis cache and sessions...${NC}"
docker-compose exec redis redis-cli FLUSHALL

# Step 2: Drop all tables (complete wipe)
echo -e "${GREEN}Step 2: Dropping all database tables...${NC}"
docker-compose exec hub-api sh -c "cd /app/apps/hub-api && npx prisma db push --force-reset --accept-data-loss"

# Step 3: Recreate schema
echo -e "${GREEN}Step 3: Recreating database schema...${NC}"
docker-compose exec hub-api sh -c "cd /app/apps/hub-api && npx prisma db push"

# Step 4: Generate fresh Prisma client
echo -e "${GREEN}Step 4: Generating fresh Prisma client...${NC}"
docker-compose exec hub-api sh -c "cd /app/apps/hub-api && npx prisma generate"

# Step 5: Create root ThreadRing
echo -e "${GREEN}Step 5: Creating root ThreadRing '${ROOT_RING_SLUG}'...${NC}"

# Create the root ring via API call
echo "Creating root ring via internal API..."
docker-compose exec hub-api sh -c "cd /app/apps/hub-api && node -e \"
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createRootRing() {
  try {
    console.log('Creating root ThreadRing...');
    
    // Create the root ring directly in database
    const rootRing = await prisma.ring.create({
      data: {
        slug: '${ROOT_RING_SLUG}',
        name: 'The Spool',
        description: 'The root ThreadRing - the origin of all rings in this hub',
        visibility: 'PUBLIC',
        joinPolicy: 'OPEN', 
        postPolicy: 'OPEN',
        ownerDid: '${INSTANCE_DID}',
        parentId: null, // Root ring has no parent
        metadata: {
          isRoot: true,
          createdBy: 'system',
          resetAt: new Date().toISOString()
        }
      }
    });
    
    console.log('✓ Root ring created:', rootRing.slug);
    
    // Create default roles
    const [ownerRole, moderatorRole, memberRole] = await Promise.all([
      prisma.ringRole.create({
        data: {
          ringId: rootRing.id,
          name: 'owner',
          permissions: [
            'manage_ring', 'manage_members', 'manage_roles', 'manage_posts',
            'moderate_content', 'invite_members', 'block_users', 'delete_ring'
          ]
        }
      }),
      prisma.ringRole.create({
        data: {
          ringId: rootRing.id, 
          name: 'moderator',
          permissions: [
            'manage_members', 'manage_posts', 'moderate_content', 'invite_members', 'block_users'
          ]
        }
      }),
      prisma.ringRole.create({
        data: {
          ringId: rootRing.id,
          name: 'member', 
          permissions: ['post_content', 'comment']
        }
      })
    ]);
    
    console.log('✓ Default roles created');
    console.log('  - owner:', ownerRole.id);
    console.log('  - moderator:', moderatorRole.id);  
    console.log('  - member:', memberRole.id);
    
    console.log('\\n🎉 Root ThreadRing setup complete!');
    console.log('Root ring:', rootRing.slug);
    console.log('Ring ID:', rootRing.id);
    
  } catch (error) {
    console.error('❌ Failed to create root ring:', error);
    process.exit(1);
  } finally {
    await prisma.\$disconnect();
  }
}

createRootRing();
\""

# Step 6: Restart services to ensure clean state
echo -e "${GREEN}Step 6: Restarting services...${NC}"
docker-compose restart hub-api redis

# Wait for services to come back up
echo "Waiting for services to restart..."
sleep 10

# Step 7: Verify setup
echo -e "${GREEN}Step 7: Verifying setup...${NC}"
echo "Checking if root ring is accessible..."

# Test health endpoint first, then ring endpoint
if curl -f -s "http://localhost:3000/health" > /dev/null; then
    echo -e "${GREEN}✓ API health check passed${NC}"
    if curl -f -s "http://localhost:3000/trp/rings/${ROOT_RING_SLUG}" > /dev/null; then
        echo -e "${GREEN}✓ Root ring API endpoint is working${NC}"
    else
        echo -e "${RED}❌ Root ring API endpoint is not responding${NC}"
        exit 1
    fi
else
    echo -e "${RED}❌ API health check failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 Production database reset complete!${NC}"
echo ""
echo "Summary of actions taken:"
echo "✓ Cleared Redis cache and sessions"
echo "✓ Dropped all existing database tables"
echo "✓ Recreated database schema"
echo "✓ Generated fresh Prisma client"  
echo "✓ Created root ThreadRing: '${ROOT_RING_SLUG}'"
echo "✓ Created default roles (owner, moderator, member)"
echo "✓ Restarted services (API and Redis)"
echo "✓ Verified API functionality"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Set up any required admin accounts"
echo "2. Configure instance-specific settings"
echo "3. Test ring creation and membership flows"
echo "4. Monitor logs for any issues"
echo ""
echo -e "${GREEN}The production environment is ready for use.${NC}"