#!/usr/bin/env node

/**
 * Debug script to check user ownership vs membership roles
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const USER_DID = 'did:web:homepageagain.com:users:1af194c245189394';

async function debugUserOwnership() {
  try {
    console.log(`🔍 Debugging ownership for: ${USER_DID}\n`);
    
    // 1. Check rings owned by this user
    console.log(`1️⃣ RINGS OWNED BY USER:`);
    const ownedRings = await prisma.ring.findMany({
      where: { ownerDid: USER_DID },
      select: {
        id: true,
        slug: true,
        name: true,
        ownerDid: true,
        visibility: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });

    if (ownedRings.length === 0) {
      console.log(`❌ User owns NO rings`);
    } else {
      console.log(`✅ User owns ${ownedRings.length} ring(s):\n`);
      for (const ring of ownedRings) {
        console.log(`  📍 ${ring.name} (${ring.slug})`);
        console.log(`     ID: ${ring.id}`);
        console.log(`     Visibility: ${ring.visibility}`);
        console.log(`     Created: ${ring.createdAt.toISOString()}`);
        console.log('     ---');
      }
    }

    // 2. Check memberships for owned rings
    if (ownedRings.length > 0) {
      console.log(`\n2️⃣ MEMBERSHIPS IN OWNED RINGS:`);
      
      for (const ring of ownedRings) {
        const membership = await prisma.membership.findFirst({
          where: {
            ringId: ring.id,
            actorDid: USER_DID
          },
          include: {
            role: { select: { name: true, permissions: true } }
          }
        });

        console.log(`\n  Ring: ${ring.name} (${ring.slug})`);
        if (!membership) {
          console.log(`  ❌ NO MEMBERSHIP FOUND - This is the problem!`);
          console.log(`     Owner has no membership record in their own ring`);
        } else {
          console.log(`  ✅ Membership exists:`);
          console.log(`     Status: ${membership.status}`);
          console.log(`     Role: ${membership.role?.name || 'NO ROLE'} ${membership.role?.name !== 'owner' ? '❌ WRONG ROLE!' : '✅'}`);
          console.log(`     Joined: ${membership.joinedAt?.toISOString() || 'Never'}`);
          console.log(`     Badge ID: ${membership.badgeId || 'No badge'}`);
          if (membership.role?.permissions) {
            console.log(`     Permissions: ${JSON.stringify(membership.role.permissions)}`);
          }
        }
      }
    }

    // 3. Check all memberships for this user
    console.log(`\n3️⃣ ALL USER MEMBERSHIPS:`);
    const allMemberships = await prisma.membership.findMany({
      where: { actorDid: USER_DID },
      include: {
        ring: { select: { slug: true, name: true, ownerDid: true, visibility: true } },
        role: { select: { name: true, permissions: true } }
      },
      orderBy: { joinedAt: 'desc' }
    });

    if (allMemberships.length === 0) {
      console.log(`❌ User has NO memberships at all`);
    } else {
      console.log(`📋 User has ${allMemberships.length} membership(s):\n`);
      
      for (const membership of allMemberships) {
        const isOwner = membership.ring.ownerDid === USER_DID;
        console.log(`  📍 ${membership.ring.name} (${membership.ring.slug})`);
        console.log(`     Owner status: ${isOwner ? '👑 OWNS THIS RING' : '👤 Regular member'}`);
        console.log(`     Role: ${membership.role?.name || 'NO ROLE'} ${isOwner && membership.role?.name !== 'owner' ? '❌ MISMATCH!' : ''}`);
        console.log(`     Status: ${membership.status}`);
        console.log(`     Badge ID: ${membership.badgeId || 'No badge'}`);
        console.log(`     Visibility: ${membership.ring.visibility}`);
        console.log('     ---');
      }
    }

    // 4. Check for owner roles in rings
    console.log(`\n4️⃣ AVAILABLE OWNER ROLES:`);
    
    if (ownedRings.length > 0) {
      for (const ring of ownedRings) {
        const ownerRoles = await prisma.ringRole.findMany({
          where: {
            ringId: ring.id,
            name: 'owner'
          }
        });

        console.log(`\n  Ring: ${ring.name} (${ring.slug})`);
        if (ownerRoles.length === 0) {
          console.log(`  ❌ NO OWNER ROLE EXISTS - This is a problem!`);
        } else {
          console.log(`  ✅ Owner role exists: ${ownerRoles[0].id}`);
          console.log(`     Permissions: ${JSON.stringify(ownerRoles[0].permissions)}`);
        }
      }
    }

    // 5. Fix recommendations
    console.log(`\n🔧 DIAGNOSIS & FIX RECOMMENDATIONS:\n`);
    
    const problems = [];
    const fixes = [];
    
    if (ownedRings.length === 0) {
      problems.push("User doesn't own any rings");
    } else {
      for (const ring of ownedRings) {
        const membership = allMemberships.find(m => m.ring.slug === ring.slug);
        
        if (!membership) {
          problems.push(`Missing membership in owned ring: ${ring.slug}`);
          fixes.push(`Create membership with owner role for ring: ${ring.slug}`);
        } else if (membership.role?.name !== 'owner') {
          problems.push(`Wrong role in owned ring ${ring.slug}: has '${membership.role?.name}', should be 'owner'`);
          fixes.push(`Update role to 'owner' in ring: ${ring.slug}`);
        }
      }
    }

    if (problems.length === 0) {
      console.log(`✅ No issues found - user should have owner badges`);
    } else {
      console.log(`❌ Issues found:`);
      problems.forEach((problem, i) => {
        console.log(`   ${i + 1}. ${problem}`);
      });
      
      console.log(`\n🛠️  Fixes needed:`);
      fixes.forEach((fix, i) => {
        console.log(`   ${i + 1}. ${fix}`);
      });
    }

  } catch (error) {
    console.error('❌ Error debugging ownership:', error);
  } finally {
    await prisma.$disconnect();
  }
}

debugUserOwnership();