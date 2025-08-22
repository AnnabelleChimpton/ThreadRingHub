#!/usr/bin/env tsx

/**
 * Script to verify actors in the production database
 * 
 * Usage:
 *   # Verify all unverified actors
 *   npm run script:verify-actors
 * 
 *   # Verify specific actor
 *   npm run script:verify-actors -- --did did:web:homepageagain.com
 * 
 *   # Dry run (show what would be updated without making changes)
 *   npm run script:verify-actors -- --dry-run
 */

import { prisma } from '../src/database/prisma';
import { verifyActor } from '../src/security/actor-manager';
import { logger } from '../src/utils/logger';

interface ScriptOptions {
  did?: string;
  dryRun?: boolean;
  limit?: number;
}

async function parseArgs(): Promise<ScriptOptions> {
  const args = process.argv.slice(2);
  const options: ScriptOptions = {
    limit: 50, // Default limit to prevent overwhelming the system
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--did':
        options.did = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--limit':
        options.limit = parseInt(args[++i], 10);
        if (isNaN(options.limit) || options.limit <= 0) {
          throw new Error('Invalid limit value');
        }
        break;
      case '--help':
        console.log(`
Usage: npm run script:verify-actors [options]

Options:
  --did <did>       Verify specific actor by DID
  --dry-run         Show what would be updated without making changes
  --limit <number>  Maximum number of actors to process (default: 50)
  --help            Show this help message
        `);
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}

async function verifySpecificActor(did: string, dryRun: boolean): Promise<void> {
  console.log(`\n🔍 Checking actor: ${did}`);
  
  const actor = await prisma.actor.findUnique({
    where: { did },
    select: { did: true, verified: true, name: true },
  });

  if (!actor) {
    console.log(`❌ Actor not found: ${did}`);
    return;
  }

  console.log(`   Current status: ${actor.verified ? '✅ Verified' : '❌ Not verified'}`);
  console.log(`   Name: ${actor.name || 'No name'}`);

  if (actor.verified) {
    console.log(`   ℹ️  Actor is already verified, skipping`);
    return;
  }

  if (dryRun) {
    console.log(`   🔄 DRY RUN: Would attempt to verify this actor`);
    return;
  }

  try {
    const success = await verifyActor(did);
    if (success) {
      console.log(`   ✅ Successfully verified actor: ${did}`);
    } else {
      console.log(`   ❌ Failed to verify actor: ${did} (DID document not accessible)`);
    }
  } catch (error) {
    console.error(`   💥 Error verifying actor: ${did}`, error);
  }
}

async function verifyAllUnverifiedActors(dryRun: boolean, limit: number): Promise<void> {
  console.log(`\n🔍 Finding unverified actors (limit: ${limit})`);
  
  const unverifiedActors = await prisma.actor.findMany({
    where: { verified: false },
    select: { did: true, name: true, discoveredAt: true },
    take: limit,
    orderBy: { discoveredAt: 'desc' },
  });

  if (unverifiedActors.length === 0) {
    console.log('🎉 No unverified actors found!');
    return;
  }

  console.log(`📋 Found ${unverifiedActors.length} unverified actors:`);
  unverifiedActors.forEach((actor, index) => {
    console.log(`   ${index + 1}. ${actor.did} (${actor.name || 'No name'})`);
  });

  if (dryRun) {
    console.log(`\n🔄 DRY RUN: Would attempt to verify these ${unverifiedActors.length} actors`);
    return;
  }

  console.log(`\n🚀 Starting verification process...`);
  
  const results = {
    success: 0,
    failed: 0,
    errors: 0,
  };

  for (let i = 0; i < unverifiedActors.length; i++) {
    const actor = unverifiedActors[i];
    const progress = `[${i + 1}/${unverifiedActors.length}]`;
    
    console.log(`\n${progress} Verifying: ${actor.did}`);
    
    try {
      const success = await verifyActor(actor.did);
      if (success) {
        console.log(`${progress} ✅ Verified: ${actor.did}`);
        results.success++;
      } else {
        console.log(`${progress} ❌ Failed: ${actor.did} (DID not accessible)`);
        results.failed++;
      }
    } catch (error) {
      console.error(`${progress} 💥 Error: ${actor.did}`, error);
      results.errors++;
    }

    // Add small delay to avoid overwhelming external DID resolvers
    if (i < unverifiedActors.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`\n📊 Verification Results:`);
  console.log(`   ✅ Successfully verified: ${results.success}`);
  console.log(`   ❌ Failed to verify: ${results.failed}`);
  console.log(`   💥 Errors: ${results.errors}`);
  console.log(`   📊 Total processed: ${results.success + results.failed + results.errors}`);
}

async function main(): Promise<void> {
  try {
    const options = await parseArgs();
    
    console.log('🔐 Actor Verification Script');
    console.log('============================');
    
    if (options.dryRun) {
      console.log('🔄 DRY RUN MODE: No changes will be made');
    }

    if (options.did) {
      await verifySpecificActor(options.did, options.dryRun || false);
    } else {
      await verifyAllUnverifiedActors(options.dryRun || false, options.limit || 50);
    }

    console.log('\n✨ Script completed successfully');
  } catch (error) {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⏹️  Script interrupted, cleaning up...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⏹️  Script terminated, cleaning up...');
  await prisma.$disconnect();
  process.exit(0);
});

if (require.main === module) {
  main();
}