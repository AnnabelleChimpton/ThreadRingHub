#!/usr/bin/env node

/**
 * Global fix for all ring owners missing joinedAt dates and badges
 * This affects all users who created rings but don't have proper owner memberships
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function fixAllOwnerMemberships() {
  try {
    console.log(`🌍 GLOBAL FIX: Fixing owner memberships for all ring creators\n`);
    
    // First, let's see the scope of the problem
    console.log(`📊 Analyzing the problem scope...\n`);
    
    // Find all rings and their owners
    const allRings = await prisma.ring.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        ownerDid: true,
        createdAt: true,
        visibility: true
      },
      orderBy: { createdAt: 'desc' }
    });

    console.log(`Found ${allRings.length} rings total`);

    // Check memberships for each ring owner
    let ownersWithBadMemberships = [];
    let totalFixed = 0;
    
    for (const ring of allRings) {
      // Find owner's membership in their own ring
      const ownerMembership = await prisma.membership.findFirst({
        where: {
          ringId: ring.id,
          actorDid: ring.ownerDid,
          status: 'ACTIVE'
        },
        include: {
          role: { select: { name: true } }
        }
      });

      if (!ownerMembership) {
        console.log(`❌ CRITICAL: ${ring.name} (${ring.slug}) - Owner has NO membership!`);
        // This is a bigger problem - owner should always have membership
        continue;
      }

      // Check for missing joinedAt or non-owner role
      const needsFixing = 
        ownerMembership.joinedAt === null || 
        ownerMembership.role?.name !== 'owner' ||
        ownerMembership.badgeId === null;

      if (needsFixing) {
        ownersWithBadMemberships.push({
          ring,
          membership: ownerMembership,
          issues: {
            missingJoinedAt: ownerMembership.joinedAt === null,
            wrongRole: ownerMembership.role?.name !== 'owner',
            noBadge: ownerMembership.badgeId === null
          }
        });
      }
    }

    console.log(`\n📈 PROBLEM SCOPE:`);
    console.log(`  Total rings: ${allRings.length}`);
    console.log(`  Rings with owner membership issues: ${ownersWithBadMemberships.length}`);
    
    if (ownersWithBadMemberships.length === 0) {
      console.log(`✅ No owner memberships need fixing!`);
      return;
    }

    // Break down the issues
    const missingJoinedAt = ownersWithBadMemberships.filter(o => o.issues.missingJoinedAt).length;
    const wrongRoles = ownersWithBadMemberships.filter(o => o.issues.wrongRole).length;
    const noBadges = ownersWithBadMemberships.filter(o => o.issues.noBadge).length;
    
    console.log(`\n🔍 ISSUE BREAKDOWN:`);
    console.log(`  Missing joinedAt dates: ${missingJoinedAt}`);
    console.log(`  Wrong roles (not 'owner'): ${wrongRoles}`);
    console.log(`  Missing badges: ${noBadges}`);

    // Ask for confirmation (with timeout)
    console.log(`\n⚠️  This will fix ${ownersWithBadMemberships.length} owner memberships`);
    console.log(`Starting fixes in 5 seconds... (Press Ctrl+C to cancel)`);
    
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log(`\n🔧 STARTING FIXES...\n`);

    // Group by owner DID to show progress
    const ownerGroups = {};
    ownersWithBadMemberships.forEach(item => {
      const did = item.ring.ownerDid;
      if (!ownerGroups[did]) {
        ownerGroups[did] = [];
      }
      ownerGroups[did].push(item);
    });

    console.log(`Working with ${Object.keys(ownerGroups).length} unique ring owners...\n`);

    for (const [ownerDid, ownerIssues] of Object.entries(ownerGroups)) {
      console.log(`👤 Fixing memberships for: ${ownerDid}`);
      console.log(`   Rings to fix: ${ownerIssues.length}`);

      for (const { ring, membership, issues } of ownerIssues) {
        console.log(`\n  🔧 ${ring.name} (${ring.slug})`);
        
        const updates = {};
        const fixedIssues = [];

        // Fix missing joinedAt
        if (issues.missingJoinedAt) {
          updates.joinedAt = ring.createdAt;
          fixedIssues.push('Set joinedAt date');
          console.log(`     ✅ Setting joinedAt to: ${ring.createdAt.toISOString()}`);
        }

        // Fix wrong role (find owner role)
        if (issues.wrongRole) {
          const ownerRole = await prisma.ringRole.findFirst({
            where: {
              ringId: ring.id,
              name: 'owner'
            }
          });

          if (ownerRole) {
            updates.roleId = ownerRole.id;
            fixedIssues.push('Updated to owner role');
            console.log(`     ✅ Updating role from '${membership.role?.name}' to 'owner'`);
          } else {
            console.log(`     ❌ No owner role found in ring - skipping role update`);
          }
        }

        // Apply updates
        if (Object.keys(updates).length > 0) {
          await prisma.membership.update({
            where: { id: membership.id },
            data: updates
          });

          // Create audit log
          await prisma.auditLog.create({
            data: {
              ringId: ring.id,
              action: 'membership.owner_fix_global',
              actorDid: 'system',
              targetDid: ownerDid,
              metadata: {
                membershipId: membership.id,
                reason: 'Global fix for owner membership issues',
                fixesApplied: fixedIssues,
                originalRole: membership.role?.name,
                issuesFixed: issues
              }
            }
          });

          totalFixed++;
          console.log(`     ✅ Fixed: ${fixedIssues.join(', ')}`);
        }

        // Note about badges (they should be generated automatically now)
        if (issues.noBadge) {
          console.log(`     💡 Badge should be generated automatically on next API interaction`);
        }
      }

      console.log(`   ---`);
    }

    console.log(`\n🎉 GLOBAL FIX COMPLETE!`);
    console.log(`  Total memberships fixed: ${totalFixed}`);
    console.log(`  Owners affected: ${Object.keys(ownerGroups).length}`);
    console.log(`\n💡 Next steps:`);
    console.log(`  - Badges should generate automatically when users interact with the API`);
    console.log(`  - Check the /trp/actors/{did}/badges endpoint to verify badges appear`);
    console.log(`  - Monitor for any remaining issues`);

  } catch (error) {
    console.error('❌ Error during global fix:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixAllOwnerMemberships();