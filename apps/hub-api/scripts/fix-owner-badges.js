#!/usr/bin/env node

/**
 * Fix missing badges for ring owners
 */

const { PrismaClient } = require('@prisma/client');
const { generateBadge } = require('../utils/badge');
const crypto = require('crypto');

const prisma = new PrismaClient();

const USER_DID = 'did:web:homepageagain.com:users:1af194c245189394';

// TODO: In production, load this from environment or key management service
const RING_HUB_PRIVATE_KEY = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
}).privateKey;

const RING_HUB_URL = process.env.RING_HUB_URL || 'https://ringhub.io';

async function fixOwnerBadges() {
  try {
    console.log(`🔧 Fixing missing owner badges for: ${USER_DID}\n`);
    
    // Get owner memberships without badges
    const ownerMemberships = await prisma.membership.findMany({
      where: {
        actorDid: USER_DID,
        badgeId: null,
        status: 'ACTIVE'
      },
      include: {
        ring: {
          select: {
            slug: true,
            name: true,
            ownerDid: true,
            badgeImageUrl: true,
            badgeImageHighResUrl: true
          }
        },
        role: {
          select: { name: true }
        }
      }
    });

    if (ownerMemberships.length === 0) {
      console.log('✅ No memberships need badge generation');
      return;
    }

    console.log(`Found ${ownerMemberships.length} memberships needing badges:\n`);

    for (const membership of ownerMemberships) {
      const ring = membership.ring;
      const isOwner = ring.ownerDid === USER_DID;
      
      console.log(`🎖️ Generating badge for ${ring.name} (${ring.slug})`);
      console.log(`   Role: ${membership.role?.name}`);
      console.log(`   Owner: ${isOwner ? 'YES' : 'NO'}`);
      
      try {
        // Get actor name
        const actor = await prisma.actor.findUnique({
          where: { did: USER_DID },
          select: { name: true }
        });

        // Generate badge
        const badge = await generateBadge(
          ring.slug,
          ring.name,
          USER_DID,
          actor?.name || 'Unknown',
          membership.role?.name || 'member',
          RING_HUB_PRIVATE_KEY,
          RING_HUB_URL,
          ring.badgeImageUrl || undefined,
          ring.badgeImageHighResUrl || undefined
        );

        // Update membership with badge ID and joined date
        await prisma.membership.update({
          where: { id: membership.id },
          data: { 
            badgeId: badge.id,
            joinedAt: new Date() // Set joined date for owners
          }
        });

        // Store badge in database
        await prisma.badge.create({
          data: {
            id: badge.id,
            membershipId: membership.id,
            badgeData: badge,
            issuedAt: new Date()
          }
        });

        console.log(`   ✅ Badge created: ${badge.id}`);
        console.log(`   🔗 URL: ${RING_HUB_URL}/badges/${badge.id}`);

        // Create audit log
        await prisma.auditLog.create({
          data: {
            ringId: membership.ringId,
            action: 'badge.generated_retroactively',
            actorDid: 'system',
            targetDid: USER_DID,
            metadata: {
              badgeId: badge.id,
              membershipId: membership.id,
              reason: 'Missing owner badge generated via script',
              role: membership.role?.name
            }
          }
        });

      } catch (error) {
        console.log(`   ❌ Failed to generate badge: ${error.message}`);
      }
      
      console.log('   ---');
    }

    console.log('\n✅ Badge generation complete!');

  } catch (error) {
    console.error('❌ Error fixing owner badges:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixOwnerBadges();