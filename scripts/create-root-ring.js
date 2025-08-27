const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createRootRing() {
  try {
    console.log('Creating root ThreadRing...');
    
    const rootSlug = process.env.ROOT_RING_SLUG || 'spool';
    const instanceDid = process.env.INSTANCE_DID;
    
    if (!instanceDid) {
      throw new Error('INSTANCE_DID environment variable is required');
    }
    
    // Create the root ring directly in database
    const rootRing = await prisma.ring.create({
      data: {
        slug: rootSlug,
        name: 'The Spool',
        description: 'The root ThreadRing - the origin of all rings in this hub',
        visibility: 'PUBLIC',
        joinPolicy: 'OPEN', 
        postPolicy: 'OPEN',
        ownerDid: instanceDid,
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
    
    console.log('\n🎉 Root ThreadRing setup complete!');
    console.log('Root ring:', rootRing.slug);
    console.log('Ring ID:', rootRing.id);
    
  } catch (error) {
    console.error('❌ Failed to create root ring:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createRootRing();