#!/usr/bin/env node

/**
 * Simple fix for missing owner badges - just update joinedAt dates
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const USER_DID = 'did:web:homepageagain.com:users:1af194c245189394';

async function fixOwnerMemberships() {
  try {
    console.log(`🔧 Fixing owner memberships for: ${USER_DID}\n`);
    
    // Get owner memberships without joinedAt dates
    const ownerMemberships = await prisma.membership.findMany({
      where: {
        actorDid: USER_DID,
        joinedAt: null,
        status: 'ACTIVE'
      },
      include: {
        ring: {
          select: {
            slug: true,
            name: true,
            ownerDid: true,
            createdAt: true
          }
        },
        role: {
          select: { name: true }
        }
      }
    });

    if (ownerMemberships.length === 0) {
      console.log('✅ No memberships need fixing');
      return;
    }

    console.log(`Found ${ownerMemberships.length} memberships needing fixes:\n`);

    for (const membership of ownerMemberships) {
      const ring = membership.ring;
      const isOwner = ring.ownerDid === USER_DID;
      
      console.log(`🔧 Fixing ${ring.name} (${ring.slug})`);
      console.log(`   Role: ${membership.role?.name}`);
      console.log(`   Owner: ${isOwner ? 'YES' : 'NO'}`);
      console.log(`   Ring created: ${ring.createdAt.toISOString()}`);
      
      // Update membership with joined date
      await prisma.membership.update({
        where: { id: membership.id },
        data: { 
          joinedAt: ring.createdAt
        }
      });

      console.log(`   ✅ Set joinedAt to: ${ring.createdAt.toISOString()}`);
      
      // Create audit log
      await prisma.auditLog.create({
        data: {
          ringId: membership.ringId,
          action: 'membership.retroactive_join_date',
          actorDid: 'system',
          targetDid: USER_DID,
          metadata: {
            membershipId: membership.id,
            reason: 'Added missing joinedAt date for owner',
            role: membership.role?.name,
            joinedAt: ring.createdAt.toISOString()
          }
        }
      });
      
      console.log('   ---');
    }

    console.log('\n✅ Membership fixes complete!');

  } catch (error) {
    console.error('❌ Error fixing owner memberships:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixOwnerMemberships();