#!/usr/bin/env tsx
/**
 * Backfill script for federated profile data
 *
 * This script resolves DID documents for all existing memberships
 * and populates profile data (actorName, avatarUrl, profileUrl, etc.)
 *
 * Usage:
 *   npm run backfill-profiles
 *   or
 *   npx tsx scripts/backfill-profiles.ts
 *
 * Options:
 *   --dry-run    - Preview changes without writing to database
 *   --limit N    - Only process N memberships (for testing)
 *   --force      - Re-resolve even if profile data already exists
 */

import { PrismaClient } from '@prisma/client';
import { resolveActorProfile } from '../src/services/profile-resolver';

const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

interface BackfillStats {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ actorDid: string; error: string }>;
}

async function backfillProfiles(options: {
  dryRun?: boolean;
  limit?: number;
  force?: boolean;
}): Promise<BackfillStats> {
  const stats: BackfillStats = {
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    console.log('🔍 Finding memberships to backfill...');
    console.log(`Options: ${JSON.stringify(options, null, 2)}\n`);

    // Build query based on options
    const where = options.force
      ? {} // Process all memberships if forcing
      : { profileUrl: null }; // Only process memberships without profile data

    // Get total count
    stats.total = await prisma.membership.count({ where });
    console.log(`📊 Found ${stats.total} memberships to process\n`);

    if (stats.total === 0) {
      console.log('✅ No memberships need backfilling!');
      return stats;
    }

    // Get unique actor DIDs to avoid processing same actor multiple times
    const memberships = await prisma.membership.findMany({
      where,
      select: {
        actorDid: true,
      },
      distinct: ['actorDid'],
      take: options.limit,
    });

    const uniqueActors = [...new Set(memberships.map((m) => m.actorDid))];
    console.log(`👥 Processing ${uniqueActors.length} unique actors\n`);

    // Process each actor
    for (let i = 0; i < uniqueActors.length; i++) {
      const actorDid = uniqueActors[i];
      stats.processed++;

      console.log(
        `[${stats.processed}/${uniqueActors.length}] Processing: ${actorDid.substring(0, 50)}...`
      );

      try {
        // Resolve profile data from DID document
        const profile = await resolveActorProfile(actorDid, options.force);

        if (!profile) {
          console.log(`  ⚠️  Failed to resolve profile (DID resolution failed)`);
          stats.failed++;
          stats.errors.push({
            actorDid,
            error: 'DID resolution failed',
          });
          continue;
        }

        if (!options.dryRun) {
          // Update all memberships for this actor
          const result = await prisma.membership.updateMany({
            where: { actorDid },
            data: {
              actorName: profile.actorName,
              avatarUrl: profile.avatarUrl,
              profileUrl: profile.profileUrl,
              instanceDomain: profile.instanceDomain,
              profileLastFetched: new Date(),
              profileSource: 'DID_RESOLUTION',
            },
          });

          console.log(
            `  ✅ Updated ${result.count} membership(s) - Name: ${profile.actorName || '(none)'}, Avatar: ${profile.avatarUrl ? 'yes' : 'no'}, Domain: ${profile.instanceDomain}`
          );
          stats.succeeded++;
        } else {
          console.log(
            `  🔍 [DRY RUN] Would update - Name: ${profile.actorName || '(none)'}, Avatar: ${profile.avatarUrl ? 'yes' : 'no'}, Domain: ${profile.instanceDomain}`
          );
          stats.succeeded++;
        }

        // Small delay to avoid overwhelming external servers
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.log(`  ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        stats.failed++;
        stats.errors.push({
          actorDid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return stats;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    limit: undefined as number | undefined,
  };

  // Parse limit option
  const limitIndex = args.indexOf('--limit');
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    options.limit = parseInt(args[limitIndex + 1], 10);
    if (isNaN(options.limit)) {
      console.error('❌ Invalid --limit value. Must be a number.');
      process.exit(1);
    }
  }

  console.log('🚀 Starting federated profile backfill...\n');

  if (options.dryRun) {
    console.log('⚠️  DRY RUN MODE - No changes will be written to database\n');
  }

  const startTime = Date.now();
  const stats = await backfillProfiles(options);
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📈 Backfill Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Total actors:     ${stats.total}`);
  console.log(`Processed:        ${stats.processed}`);
  console.log(`Succeeded:        ${stats.succeeded}`);
  console.log(`Failed:           ${stats.failed}`);
  console.log(`Skipped:          ${stats.skipped}`);
  console.log(`Duration:         ${duration}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (stats.errors.length > 0) {
    console.log('❌ Errors encountered:');
    stats.errors.forEach(({ actorDid, error }) => {
      console.log(`  - ${actorDid}: ${error}`);
    });
    console.log('');
  }

  if (options.dryRun) {
    console.log('⚠️  This was a DRY RUN. Run without --dry-run to apply changes.\n');
  } else {
    console.log('✅ Backfill complete!\n');
  }

  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
