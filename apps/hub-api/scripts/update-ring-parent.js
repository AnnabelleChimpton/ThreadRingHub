#!/usr/bin/env node

/**
 * CLI script to update the parent of a threadring
 * Usage: node scripts/update-ring-parent.js <child-slug> <parent-slug>
 * Usage: node scripts/update-ring-parent.js <child-slug> --root (to set parent to root)
 * Usage: node scripts/update-ring-parent.js <child-slug> --null (to set parent to null)
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function updateRingParent(childSlug, parentSlug = null) {
  try {
    console.log(`🔍 Looking up threadring "${childSlug}"...`);
    
    // Find the child ring
    const childRing = await prisma.ring.findUnique({
      where: { slug: childSlug },
      select: { id: true, slug: true, name: true, parentId: true, ownerDid: true }
    });

    if (!childRing) {
      console.error(`❌ Error: ThreadRing with slug "${childSlug}" not found`);
      process.exit(1);
    }

    console.log(`✅ Found threadring: ${childRing.name} (${childRing.slug})`);

    let newParentId = null;
    let parentRing = null;

    // Handle parent lookup
    if (parentSlug && parentSlug !== '--null' && parentSlug !== '--root') {
      console.log(`🔍 Looking up parent threadring "${parentSlug}"...`);
      
      parentRing = await prisma.ring.findUnique({
        where: { slug: parentSlug },
        select: { id: true, slug: true, name: true }
      });

      if (!parentRing) {
        console.error(`❌ Error: Parent threadring with slug "${parentSlug}" not found`);
        process.exit(1);
      }

      console.log(`✅ Found parent threadring: ${parentRing.name} (${parentRing.slug})`);
      newParentId = parentRing.id;
    } else if (parentSlug === '--root') {
      // Find the root ring (assuming it's called "spool")
      console.log(`🔍 Looking up root threadring...`);
      
      parentRing = await prisma.ring.findUnique({
        where: { slug: 'spool' }, // Default root slug based on config
        select: { id: true, slug: true, name: true }
      });

      if (!parentRing) {
        console.error(`❌ Error: Root threadring not found. Expected slug "spool"`);
        process.exit(1);
      }

      console.log(`✅ Found root threadring: ${parentRing.name} (${parentRing.slug})`);
      newParentId = parentRing.id;
    } else if (parentSlug === '--null') {
      console.log(`🔄 Setting parent to null (orphaning the threadring)`);
      newParentId = null;
    }

    // Check for circular references
    if (newParentId) {
      console.log(`🔄 Checking for circular references...`);
      
      // Don't allow setting parent to itself
      if (newParentId === childRing.id) {
        console.error(`❌ Error: ThreadRing cannot be its own parent`);
        process.exit(1);
      }

      // Check if the new parent is a descendant of the child ring
      let checkRing = parentRing;
      const visited = new Set([childRing.id]);
      
      while (checkRing && checkRing.parentId) {
        if (visited.has(checkRing.parentId)) {
          console.error(`❌ Error: Cannot create circular parent-child relationship`);
          process.exit(1);
        }
        visited.add(checkRing.parentId);
        
        checkRing = await prisma.ring.findUnique({
          where: { id: checkRing.parentId },
          select: { id: true, parentId: true }
        });
      }

      console.log(`✅ No circular references found`);
    }

    // Show current state
    if (childRing.parentId) {
      const currentParent = await prisma.ring.findUnique({
        where: { id: childRing.parentId },
        select: { slug: true, name: true }
      });
      console.log(`📍 Current parent: ${currentParent?.name} (${currentParent?.slug})`);
    } else {
      console.log(`📍 Current parent: None (orphaned)`);
    }

    // Show new state
    if (newParentId && parentRing) {
      console.log(`🎯 New parent: ${parentRing.name} (${parentRing.slug})`);
    } else {
      console.log(`🎯 New parent: None (will be orphaned)`);
    }

    // Update the ring
    console.log(`🔄 Updating parent relationship...`);
    
    const updatedRing = await prisma.ring.update({
      where: { slug: childSlug },
      data: {
        parentId: newParentId,
        updatedAt: new Date(),
      },
    });

    // Log the action in audit log
    await prisma.auditLog.create({
      data: {
        ringId: childRing.id,
        action: 'ring.parent_updated',
        actorDid: 'system', // Since this is a system operation
        metadata: {
          previousParentId: childRing.parentId,
          newParentId: newParentId,
          parentSlug: parentSlug,
          updatedViaScript: true,
          scriptTimestamp: new Date().toISOString()
        },
      },
    });

    console.log(`✅ Successfully updated parent relationship!`);
    console.log(`📊 ThreadRing "${childRing.name}" (${childRing.slug}) now has parent: ${parentRing ? `${parentRing.name} (${parentRing.slug})` : 'None'}`);

  } catch (error) {
    console.error(`❌ Error updating parent relationship:`, error.message);
    if (error.code === 'P2002') {
      console.error('This might be a unique constraint violation. Check if the relationship already exists.');
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log(`
Usage: node scripts/update-ring-parent.js <child-slug> [parent-slug|--root|--null]

Examples:
  node scripts/update-ring-parent.js my-ring parent-ring    # Set specific parent
  node scripts/update-ring-parent.js my-ring --root        # Set parent to root ring (spool)
  node scripts/update-ring-parent.js my-ring --null        # Remove parent (orphan)
  node scripts/update-ring-parent.js my-ring               # Same as --null

Arguments:
  child-slug    - Slug of the threadring whose parent you want to change
  parent-slug   - Slug of the new parent threadring
  --root        - Set parent to the root threadring (spool)
  --null        - Remove parent (orphan the threadring)
`);
  process.exit(1);
}

const [childSlug, parentSlug] = args;

// Run the update
updateRingParent(childSlug, parentSlug);