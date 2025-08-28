#!/usr/bin/env node

/**
 * Script to manually set a post to REMOVED status
 * Usage: node scripts/remove-post.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function removeFirstPostFromRing(ringSlug) {
  try {
    console.log(`🔍 Looking up ring "${ringSlug}"...`);
    
    // Find the ring
    const ring = await prisma.ring.findUnique({
      where: { slug: ringSlug },
      select: { id: true, slug: true, name: true }
    });

    if (!ring) {
      console.error(`❌ Error: Ring with slug "${ringSlug}" not found`);
      process.exit(1);
    }

    console.log(`✅ Found ring: ${ring.name} (${ring.slug})`);

    // Find the first post in this ring
    console.log(`🔍 Looking for the first post in this ring...`);
    
    const firstPost = await prisma.postRef.findFirst({
      where: {
        ringId: ring.id
      },
      orderBy: {
        submittedAt: 'asc'  // Get the earliest post
      },
      include: {
        ring: { select: { slug: true, name: true } }
      }
    });

    if (!firstPost) {
      console.error(`❌ No posts found in ring "${ringSlug}"`);
      process.exit(1);
    }

    console.log(`\n📄 Found first post:`);
    console.log(`  ID: ${firstPost.id}`);
    console.log(`  URI: ${firstPost.uri}`);
    console.log(`  Author DID: ${firstPost.actorDid}`);
    console.log(`  Submitted: ${firstPost.submittedAt.toISOString()}`);
    console.log(`  Current Status: ${firstPost.status}`);
    console.log(`  Digest: ${firstPost.digest.substring(0, 20)}...`);
    
    if (firstPost.metadata) {
      const metadata = firstPost.metadata;
      if (metadata.title) {
        console.log(`  Title: ${metadata.title}`);
      }
      if (metadata.textPreview) {
        console.log(`  Preview: ${metadata.textPreview.substring(0, 50)}...`);
      }
    }

    // Confirm before updating
    console.log(`\n⚠️  This will set the post status to REMOVED`);
    console.log(`Press Ctrl+C to cancel, or wait 3 seconds to continue...`);
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Update the post to REMOVED status
    console.log(`\n🔄 Updating post status to REMOVED...`);
    
    const updatedPost = await prisma.postRef.update({
      where: { id: firstPost.id },
      data: {
        status: 'REMOVED',
        moderatedAt: new Date(),
        moderatedBy: 'system',
        moderationNote: 'Manually removed via script - author deleted before removal endpoint was available'
      }
    });

    // Create audit log entry
    await prisma.auditLog.create({
      data: {
        ringId: ring.id,
        action: 'content.manually_removed',
        actorDid: 'system',
        targetDid: firstPost.actorDid,
        metadata: {
          postId: firstPost.id,
          uri: firstPost.uri,
          reason: 'Manually removed via script - author deleted before removal endpoint was available',
          scriptTimestamp: new Date().toISOString()
        }
      }
    });

    console.log(`✅ Successfully updated post status to REMOVED`);
    console.log(`\n📊 Updated Post Details:`);
    console.log(`  ID: ${updatedPost.id}`);
    console.log(`  Status: ${updatedPost.status}`);
    console.log(`  Moderated At: ${updatedPost.moderatedAt?.toISOString()}`);
    console.log(`  Moderated By: ${updatedPost.moderatedBy}`);
    console.log(`  Note: ${updatedPost.moderationNote}`);

    // Check if this post exists in other rings
    console.log(`\n🔍 Checking if this content exists in other rings...`);
    
    const otherInstances = await prisma.postRef.findMany({
      where: {
        uri: firstPost.uri,
        actorDid: firstPost.actorDid,
        id: { not: firstPost.id }
      },
      include: {
        ring: { select: { slug: true, name: true } }
      }
    });

    if (otherInstances.length > 0) {
      console.log(`\n⚠️  This content also exists in ${otherInstances.length} other ring(s):`);
      for (const instance of otherInstances) {
        console.log(`  - ${instance.ring.name} (${instance.ring.slug}) - Status: ${instance.status}`);
      }
      
      console.log(`\n💡 To remove from ALL rings, use the /trp/curate endpoint as the author,`);
      console.log(`   or run this script again for each ring.`);
    } else {
      console.log(`✅ This content only existed in the "${ringSlug}" ring.`);
    }

  } catch (error) {
    console.error(`❌ Error updating post:`, error.message);
    if (error.code === 'P2025') {
      console.error('Post not found or already deleted.');
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
const ringSlug = 'big-brother';
console.log(`🚀 Starting removal process for first post in "${ringSlug}" ring...\n`);
removeFirstPostFromRing(ringSlug);