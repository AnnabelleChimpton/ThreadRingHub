#!/usr/bin/env node

/**
 * Script to manually remove a specific post
 * Usage: node scripts/remove-specific-post.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const POST_ID = 'e53a6ebe-26c7-482d-af42-731c5c6a4006';
const AUTHOR_DID = 'did:web:homepageagain.com:users:1af194c245189394';

async function removeSpecificPost() {
  try {
    console.log(`🎯 Removing specific post: ${POST_ID}\n`);
    
    // Update the post to REMOVED status
    const updatedPost = await prisma.postRef.update({
      where: { id: POST_ID },
      data: {
        status: 'REMOVED',
        moderatedAt: new Date(),
        moderatedBy: AUTHOR_DID,
        moderationNote: 'Removed by author via manual script - original client deletion failed'
      }
    });

    // Create audit log entry
    await prisma.auditLog.create({
      data: {
        ringId: updatedPost.ringId,
        action: 'content.author_removed_manually',
        actorDid: AUTHOR_DID,
        targetDid: null,
        metadata: {
          postId: POST_ID,
          uri: updatedPost.uri,
          reason: 'Removed by author via manual script - original client deletion failed',
          scriptTimestamp: new Date().toISOString(),
          originalClientDeletionFailed: true
        }
      }
    });

    console.log(`✅ Successfully removed post from cats ring!`);
    console.log(`\n📊 Updated Details:`);
    console.log(`  Status: ${updatedPost.status} ❌`);
    console.log(`  Moderated At: ${updatedPost.moderatedAt?.toISOString()}`);
    console.log(`  Moderated By: ${updatedPost.moderatedBy} (author)`);
    console.log(`  Note: ${updatedPost.moderationNote}`);

  } catch (error) {
    console.error(`❌ Error removing post:`, error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run it
removeSpecificPost();