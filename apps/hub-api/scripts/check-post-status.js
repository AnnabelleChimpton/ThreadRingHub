#!/usr/bin/env node

/**
 * Script to check the status of a specific post and its audit history
 * Usage: node scripts/check-post-status.js <post-id>
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkPostStatus(postId) {
  try {
    console.log(`🔍 Checking status of post: ${postId}\n`);
    
    // Find the post
    const post = await prisma.postRef.findUnique({
      where: { id: postId },
      include: {
        ring: { 
          select: { 
            id: true,
            slug: true, 
            name: true 
          } 
        }
      }
    });

    if (!post) {
      console.log(`❌ Post not found in database`);
      console.log(`This could mean:`);
      console.log(`  1. The post was hard deleted (not just set to REMOVED)`);
      console.log(`  2. The post ID is incorrect`);
      console.log(`  3. The post never existed\n`);
      
      // Check if there are any audit logs for this post ID
      console.log(`🔍 Checking audit logs for any reference to this post ID...\n`);
      
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          OR: [
            { metadata: { path: ['postId'], equals: postId } },
            { metadata: { path: ['uri'], string_contains: 'cmevvqnrx0001zimwgl8is0na' } }
          ]
        },
        orderBy: { timestamp: 'desc' },
        take: 10
      });

      if (auditLogs.length > 0) {
        console.log(`📜 Found ${auditLogs.length} audit log entries mentioning this post:\n`);
        for (const log of auditLogs) {
          console.log(`  Action: ${log.action}`);
          console.log(`  Actor: ${log.actorDid}`);
          console.log(`  Timestamp: ${log.timestamp.toISOString()}`);
          if (log.metadata) {
            console.log(`  Metadata: ${JSON.stringify(log.metadata, null, 2)}`);
          }
          console.log('  ---');
        }
      } else {
        console.log(`📜 No audit logs found for this post ID`);
      }

    } else {
      // Post exists, show its details
      console.log(`✅ Post found in database:\n`);
      console.log(`📄 Post Details:`);
      console.log(`  ID: ${post.id}`);
      console.log(`  Ring: ${post.ring.name} (${post.ring.slug})`);
      console.log(`  URI: ${post.uri}`);
      console.log(`  Author DID: ${post.actorDid}`);
      console.log(`  Submitted By: ${post.submittedBy}`);
      console.log(`  Submitted At: ${post.submittedAt.toISOString()}`);
      console.log(`  Status: ${post.status} ${post.status === 'REMOVED' ? '❌' : post.status === 'ACCEPTED' ? '✅' : '⏳'}`);
      console.log(`  Digest: ${post.digest}`);
      console.log(`  Pinned: ${post.pinned ? 'Yes 📌' : 'No'}`);
      
      if (post.moderatedAt) {
        console.log(`  Moderated At: ${post.moderatedAt.toISOString()}`);
        console.log(`  Moderated By: ${post.moderatedBy || 'N/A'}`);
        console.log(`  Moderation Note: ${post.moderationNote || 'N/A'}`);
      }
      
      if (post.metadata) {
        console.log(`  Metadata: ${JSON.stringify(post.metadata, null, 2)}`);
      }

      // Check for other instances of this content
      console.log(`\n🔍 Checking for other instances of this content (same URI)...\n`);
      
      const otherInstances = await prisma.postRef.findMany({
        where: {
          uri: post.uri,
          id: { not: post.id }
        },
        include: {
          ring: { select: { slug: true, name: true } }
        }
      });

      if (otherInstances.length > 0) {
        console.log(`📍 Found ${otherInstances.length} other instance(s) of this content:\n`);
        for (const instance of otherInstances) {
          console.log(`  Ring: ${instance.ring.name} (${instance.ring.slug})`);
          console.log(`  Status: ${instance.status}`);
          console.log(`  Submitted: ${instance.submittedAt.toISOString()}`);
          console.log('  ---');
        }
      } else {
        console.log(`📍 No other instances of this content found in other rings`);
      }

      // Check audit logs
      console.log(`\n📜 Checking audit logs for this post...\n`);
      
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          OR: [
            { ringId: post.ring.id, metadata: { path: ['postId'], equals: postId } },
            { ringId: post.ring.id, metadata: { path: ['uri'], equals: post.uri } },
            { ringId: post.ring.id, targetDid: post.actorDid, action: { contains: 'content' } }
          ]
        },
        orderBy: { timestamp: 'desc' },
        take: 10
      });

      if (auditLogs.length > 0) {
        console.log(`Found ${auditLogs.length} related audit log entries:\n`);
        for (const log of auditLogs) {
          console.log(`  ${log.timestamp.toISOString()}: ${log.action}`);
          console.log(`  Actor: ${log.actorDid}`);
          if (log.targetDid) {
            console.log(`  Target: ${log.targetDid}`);
          }
          if (log.metadata) {
            const metadata = log.metadata;
            if (metadata.reason) {
              console.log(`  Reason: ${metadata.reason}`);
            }
            if (metadata.postId === postId) {
              console.log(`  ✓ References this post`);
            }
          }
          console.log('  ---');
        }
      } else {
        console.log(`No audit logs found for this post`);
      }
    }

    // Check if the user attempted to delete it
    console.log(`\n🔍 Checking for failed deletion attempts by the author...\n`);
    
    const authorDid = post?.actorDid || 'did:web:homepageagain.com:users:1af194c245189394';
    const failedAttempts = await prisma.auditLog.findMany({
      where: {
        actorDid: authorDid,
        action: { contains: 'remove' },
        timestamp: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
        }
      },
      orderBy: { timestamp: 'desc' },
      take: 10
    });

    if (failedAttempts.length > 0) {
      console.log(`Found ${failedAttempts.length} removal attempt(s) by the author in the last 7 days:\n`);
      for (const attempt of failedAttempts) {
        console.log(`  ${attempt.timestamp.toISOString()}: ${attempt.action}`);
        if (attempt.metadata) {
          console.log(`  Metadata: ${JSON.stringify(attempt.metadata, null, 2)}`);
        }
        console.log('  ---');
      }
    } else {
      console.log(`No removal attempts found by the author in the last 7 days`);
    }

  } catch (error) {
    console.error(`❌ Error checking post status:`, error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const postId = args[0] || 'e53a6ebe-26c7-482d-af42-731c5c6a4006'; // Default to the post you mentioned

if (!postId) {
  console.log(`
Usage: node scripts/check-post-status.js <post-id>

Example:
  node scripts/check-post-status.js e53a6ebe-26c7-482d-af42-731c5c6a4006
`);
  process.exit(1);
}

// Run the check
checkPostStatus(postId);