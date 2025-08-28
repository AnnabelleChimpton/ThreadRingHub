#!/usr/bin/env node

/**
 * Script to analyze why a specific post deletion might have failed
 * Usage: node scripts/analyze-post-deletion.js <post-id>
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function analyzePostDeletion(postId) {
  try {
    console.log(`🔍 Analyzing deletion failure for post: ${postId}\n`);
    
    // Get the post details
    const post = await prisma.postRef.findUnique({
      where: { id: postId },
      include: {
        ring: { select: { id: true, slug: true, name: true } }
      }
    });

    if (!post) {
      console.log(`❌ Post not found - it may have been successfully deleted!`);
      
      // Check audit logs for deletion
      const deletionLogs = await prisma.auditLog.findMany({
        where: {
          metadata: { path: ['postId'], equals: postId }
        },
        orderBy: { timestamp: 'desc' }
      });

      if (deletionLogs.length > 0) {
        console.log(`\n📜 Found deletion audit logs:\n`);
        for (const log of deletionLogs) {
          console.log(`  ${log.timestamp.toISOString()}: ${log.action}`);
          console.log(`  Actor: ${log.actorDid}`);
          if (log.metadata?.reason) {
            console.log(`  Reason: ${log.metadata.reason}`);
          }
          console.log('  ---');
        }
      }
      return;
    }

    console.log(`✅ Post still exists in database:\n`);
    console.log(`📄 Current Status:`);
    console.log(`  ID: ${post.id}`);
    console.log(`  Ring: ${post.ring.name} (${post.ring.slug})`);
    console.log(`  Status: ${post.status} ${post.status === 'REMOVED' ? '❌' : '✅'}`);
    console.log(`  Author: ${post.actorDid}`);
    console.log(`  URI: ${post.uri}`);
    
    // Extract the content ID from the URI for client mapping
    const uriMatch = post.uri.match(/\/post\/([^\/]+)$/);
    const contentId = uriMatch ? uriMatch[1] : 'unknown';
    console.log(`  Content ID (from URI): ${contentId}`);
    console.log(`  Digest: ${post.digest}`);

    // Look for recent failed deletion attempts
    console.log(`\n🔍 Checking for recent deletion attempts...\n`);
    
    // Check for audit logs related to this post
    const recentLogs = await prisma.auditLog.findMany({
      where: {
        OR: [
          { ringId: post.ring.id, metadata: { path: ['postId'], equals: postId } },
          { ringId: post.ring.id, metadata: { path: ['uri'], equals: post.uri } },
          { actorDid: post.actorDid, action: { contains: 'remove' }, 
            timestamp: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } } // Last 2 hours
        ]
      },
      orderBy: { timestamp: 'desc' },
      take: 10
    });

    if (recentLogs.length > 0) {
      console.log(`📜 Recent related activity (last 2 hours):\n`);
      for (const log of recentLogs) {
        console.log(`  ${log.timestamp.toISOString()}: ${log.action}`);
        console.log(`  Actor: ${log.actorDid}`);
        if (log.metadata) {
          if (log.metadata.postId === postId) {
            console.log(`  ✓ References this exact post`);
          }
          if (log.metadata.uri === post.uri) {
            console.log(`  ✓ References same URI`);
          }
          if (log.metadata.reason) {
            console.log(`  Reason: ${log.metadata.reason}`);
          }
        }
        console.log('  ---');
      }
    }

    // Check for server logs around the time of submission
    const submissionTime = post.submittedAt;
    const windowStart = new Date(submissionTime.getTime() + 1000); // 1 second after submission
    const windowEnd = new Date(submissionTime.getTime() + 30 * 60 * 1000); // 30 minutes after
    
    console.log(`\n🔍 Checking for deletion attempts after submission...\n`);
    console.log(`  Submission: ${submissionTime.toISOString()}`);
    console.log(`  Checking window: ${windowStart.toISOString()} to ${windowEnd.toISOString()}\n`);
    
    const postSubmissionLogs = await prisma.auditLog.findMany({
      where: {
        actorDid: post.actorDid,
        timestamp: {
          gte: windowStart,
          lte: windowEnd
        },
        action: { contains: 'content' }
      },
      orderBy: { timestamp: 'asc' }
    });

    if (postSubmissionLogs.length > 0) {
      console.log(`📜 Content actions after submission:\n`);
      for (const log of postSubmissionLogs) {
        console.log(`  ${log.timestamp.toISOString()}: ${log.action}`);
        console.log(`  Ring ID: ${log.ringId}`);
        if (log.metadata?.postId) {
          console.log(`  Post ID: ${log.metadata.postId} ${log.metadata.postId === postId ? '✓ MATCH' : ''}`);
        }
        if (log.metadata?.uri) {
          console.log(`  URI: ${log.metadata.uri} ${log.metadata.uri === post.uri ? '✓ MATCH' : ''}`);
        }
        console.log('  ---');
      }
    } else {
      console.log(`No content actions found after submission - this suggests the deletion attempt never reached the server successfully.`);
    }

    // Possible reasons for deletion failure
    console.log(`\n💡 Possible reasons for deletion failure:\n`);
    
    if (post.status === 'ACCEPTED') {
      console.log(`1. ❌ Client sent wrong post ID (content ID vs database UUID)`);
      console.log(`   - Client might have sent: ${contentId}`);
      console.log(`   - Server expects: ${postId}`);
      console.log(`\n2. ❌ HTTP signature verification failed`);
      console.log(`   - Check if client signature generation is working`);
      console.log(`\n3. ❌ Network/connection issues`);
      console.log(`   - Request never reached the server`);
      console.log(`\n4. ❌ Client-side error handling`);
      console.log(`   - Request failed but client didn't show error`);
    } else if (post.status === 'REMOVED') {
      console.log(`✅ Post was successfully deleted (status: REMOVED)`);
      console.log(`   - Client might not have refreshed to see the change`);
    }

    // Recommendations
    console.log(`\n🔧 Recommendations:\n`);
    console.log(`1. Update client to use database UUID: ${postId}`);
    console.log(`2. Test deletion with correct ID using curl:`);
    console.log(`   curl -X POST https://ringhub.io/trp/curate \\`);
    console.log(`     -H "Content-Type: application/json" \\`);
    console.log(`     -H "Authorization: <signature>" \\`);
    console.log(`     -d '{"postId":"${postId}","action":"remove","reason":"Author deletion"}'`);
    console.log(`\n3. Or use manual script:`);
    console.log(`   # Update POST_ID in remove-specific-post.js to: ${postId}`);
    console.log(`   node scripts/remove-specific-post.js`);

  } catch (error) {
    console.error(`❌ Error analyzing deletion:`, error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const postId = args[0] || 'd899b00b-3475-404e-bcb7-30fa69da62f3'; // Default to the post mentioned

if (!postId) {
  console.log(`
Usage: node scripts/analyze-post-deletion.js <post-id>

Example:
  node scripts/analyze-post-deletion.js d899b00b-3475-404e-bcb7-30fa69da62f3
`);
  process.exit(1);
}

// Run the analysis
analyzePostDeletion(postId);