#!/usr/bin/env node

/**
 * Generate badges for all owner memberships that are missing them
 */

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// Load the badge utility - try different paths
let generateBadge;
try {
  generateBadge = require('../src/utils/badge').generateBadge;
} catch (error) {
  try {
    generateBadge = require('./src/utils/badge').generateBadge;
  } catch (error2) {
    console.error('❌ Could not load badge utility. Creating simple badges instead.');
  }
}

// Generate a temporary key pair for badge signing
const TEMP_KEY_PAIR = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const RING_HUB_URL = process.env.RING_HUB_URL || 'https://ringhub.io';

async function generateSimpleBadge(ringSlug, ringName, actorDid, actorName, role) {
  const badgeId = crypto.randomBytes(16).toString('base64url');
  
  // Create a simple JSON-LD badge structure
  const badge = {
    "@context": ["https://www.w3.org/2018/credentials/v1", "https://purl.imsglobal.org/spec/ob/v3p0/context.json"],
    "id": `${RING_HUB_URL}/badges/${badgeId}`,
    "type": ["VerifiableCredential", "OpenBadgeCredential"],
    "issuer": {
      "id": RING_HUB_URL,
      "type": "Profile",
      "name": "ThreadRing Hub"
    },
    "credentialSubject": {
      "id": actorDid,
      "type": "Profile",
      "name": actorName,
      "achievement": {
        "id": `${RING_HUB_URL}/rings/${ringSlug}/achievement`,
        "type": "Achievement",
        "name": `${ringName} - ${role}`,
        "description": `${role} role in ThreadRing: ${ringName}`,
        "criteria": {
          "narrative": `Holder has ${role} role in the ${ringName} ThreadRing`
        }
      }
    },
    "issuanceDate": new Date().toISOString(),
    "proof": {
      "type": "Ed25519Signature2020",
      "created": new Date().toISOString(),
      "verificationMethod": `${RING_HUB_URL}#key-1`,
      "proofPurpose": "assertionMethod",
      "proofValue": "temporary-proof-for-missing-badges"
    }
  };

  return { id: badgeId, ...badge };
}

async function generateMissingBadges() {
  try {
    console.log(`🎖️ Generating missing owner badges...\n`);
    
    // Find all active memberships without badges
    const membershipsWithoutBadges = await prisma.membership.findMany({
      where: {
        status: 'ACTIVE',
        badgeId: null,
        joinedAt: { not: null } // Only ones with joinedAt dates (should be fixed now)
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
      },
      orderBy: { joinedAt: 'desc' }
    });

    if (membershipsWithoutBadges.length === 0) {
      console.log('✅ No memberships missing badges!');
      return;
    }

    console.log(`Found ${membershipsWithoutBadges.length} memberships without badges:\n`);

    let generated = 0;
    let failed = 0;

    for (const membership of membershipsWithoutBadges) {
      const ring = membership.ring;
      const isOwner = ring.ownerDid === membership.actorDid;
      const role = membership.role?.name || 'member';
      
      console.log(`🔧 ${ring.name} (${ring.slug})`);
      console.log(`   Actor: ${membership.actorDid}`);
      console.log(`   Role: ${role} ${isOwner ? '👑' : ''}`);
      
      try {
        // Get actor name
        const actor = await prisma.actor.findUnique({
          where: { did: membership.actorDid },
          select: { name: true }
        });

        let badge;
        
        if (generateBadge) {
          // Use real badge generation if available
          badge = await generateBadge(
            ring.slug,
            ring.name,
            membership.actorDid,
            actor?.name || 'Unknown',
            role,
            TEMP_KEY_PAIR.privateKey,
            RING_HUB_URL,
            ring.badgeImageUrl,
            ring.badgeImageHighResUrl
          );
        } else {
          // Use simple badge generation
          badge = await generateSimpleBadge(
            ring.slug,
            ring.name,
            membership.actorDid,
            actor?.name || 'Unknown',
            role
          );
        }

        // Update membership with badge ID
        await prisma.membership.update({
          where: { id: membership.id },
          data: { badgeId: badge.id }
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

        // Create audit log
        await prisma.auditLog.create({
          data: {
            ringId: membership.ringId,
            action: 'badge.generated_retroactively',
            actorDid: 'system',
            targetDid: membership.actorDid,
            metadata: {
              badgeId: badge.id,
              membershipId: membership.id,
              reason: 'Missing badge generated via script',
              role: role,
              isOwner: isOwner
            }
          }
        });

        console.log(`   ✅ Badge created: ${badge.id}`);
        generated++;

      } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
        failed++;
      }
      
      console.log('   ---');
    }

    console.log(`\n🎉 Badge generation complete!`);
    console.log(`  Generated: ${generated}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Total processed: ${membershipsWithoutBadges.length}`);

    if (generated > 0) {
      console.log(`\n💡 Test the badges API now:`);
      console.log(`curl https://ringhub.io/trp/actors/YOUR_DID/badges?status=active`);
    }

  } catch (error) {
    console.error('❌ Error generating badges:', error);
  } finally {
    await prisma.$disconnect();
  }
}

generateMissingBadges();