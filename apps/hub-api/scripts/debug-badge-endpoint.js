#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const USER_DID = 'did:web:homepageagain.com:users:1af194c245189394';

async function debugBadgeEndpoint() {
  try {
    console.log(`🔍 Debugging badge endpoint for: ${USER_DID}\n`);
    
    // 1. Check current memberships after the fix
    console.log(`1️⃣ CURRENT MEMBERSHIPS (after fix):`);
    const memberships = await prisma.membership.findMany({
      where: { 
        actorDid: USER_DID,
        status: 'ACTIVE'
      },
      include: {
        ring: { select: { slug: true, name: true, ownerDid: true, visibility: true } },
        role: { select: { name: true } }
      },
      orderBy: { joinedAt: 'desc' }
    });

    for (const m of memberships) {
      const isOwner = m.ring.ownerDid === USER_DID;
      console.log(`  📍 ${m.ring.name} (${m.ring.slug})`);
      console.log(`     Role: ${m.role?.name}`);
      console.log(`     Owner: ${isOwner}`);
      console.log(`     JoinedAt: ${m.joinedAt?.toISOString() || 'NULL'}`);
      console.log(`     BadgeId: ${m.badgeId || 'NULL'}`);
      console.log(`     Visibility: ${m.ring.visibility}`);
      console.log('     ---');
    }

    // 2. Check what badges exist in database
    console.log(`\n2️⃣ BADGES IN DATABASE:`);
    const badges = await prisma.badge.findMany({
      where: {
        membership: {
          actorDid: USER_DID
        }
      },
      include: {
        membership: {
          include: {
            ring: { select: { slug: true, name: true, visibility: true } },
            role: { select: { name: true } }
          }
        }
      }
    });

    if (badges.length === 0) {
      console.log(`❌ NO BADGES found in database for this user`);
      console.log(`This explains why the endpoint returns no owner badges!`);
    } else {
      console.log(`Found ${badges.length} badge(s) in database:`);
      for (const badge of badges) {
        console.log(`  🎖️ ${badge.membership.ring.name} (${badge.membership.ring.slug})`);
        console.log(`     Role: ${badge.membership.role?.name}`);
        console.log(`     Badge ID: ${badge.id}`);
        console.log(`     Issued: ${badge.issuedAt.toISOString()}`);
        console.log(`     Revoked: ${badge.revokedAt ? 'YES' : 'NO'}`);
        console.log(`     Visibility: ${badge.membership.ring.visibility}`);
        console.log('     ---');
      }
    }

    // 3. Test the endpoint query logic
    console.log(`\n3️⃣ TESTING ENDPOINT QUERY LOGIC:`);
    
    // This mimics the badges endpoint query
    const endpointBadges = await prisma.badge.findMany({
      where: {
        revokedAt: null, // status=active filter
        membership: {
          actorDid: USER_DID,
          status: 'ACTIVE'
        }
      },
      include: {
        membership: {
          include: {
            ring: { select: { slug: true, name: true, visibility: true } },
            role: { select: { name: true } }
          }
        }
      }
    });

    // Filter out private rings (endpoint logic)
    const filteredBadges = endpointBadges.filter(badge => 
      badge.membership.ring.visibility !== 'PRIVATE'
    );

    console.log(`Raw query results: ${endpointBadges.length} badges`);
    console.log(`After private ring filter: ${filteredBadges.length} badges`);
    
    if (filteredBadges.length !== badges.length) {
      console.log(`⚠️  Some badges were filtered out due to private ring visibility`);
    }

    // 4. Diagnosis
    console.log(`\n💡 DIAGNOSIS:`);
    const ownedRings = memberships.filter(m => m.ring.ownerDid === USER_DID);
    const ownerMembershipsWithoutBadges = ownedRings.filter(m => !m.badgeId);
    
    if (ownerMembershipsWithoutBadges.length > 0) {
      console.log(`❌ Root cause: ${ownerMembershipsWithoutBadges.length} owner memberships don't have badges generated yet`);
      console.log(`\n🔧 SOLUTION: Need to generate badges for these memberships:`);
      for (const m of ownerMembershipsWithoutBadges) {
        console.log(`  - ${m.ring.name} (${m.ring.slug}) - Role: ${m.role?.name}`);
      }
      console.log(`\nThe /join endpoint or a badge generation script needs to run.`);
    } else {
      console.log(`✅ All memberships have badges - the issue might be elsewhere`);
    }

  } catch (error) {
    console.error('❌ Error debugging badge endpoint:', error);
  } finally {
    await prisma.$disconnect();
  }
}

debugBadgeEndpoint();