/**
 * One-shot: re-sign badges whose proof does NOT verify with the current key.
 *
 * Replaces the old boot-time `resignBadges()` hook (src/utils/migration.ts,
 * removed 2026-10-17), which ran on every start, re-minted EVERY badge with a
 * new id, dropped badge images, and in practice failed on every row because it
 * created the new Badge before deleting the old one (membershipId is @unique).
 *
 * What this does instead (FUTURE_IMPROVEMENTS B3):
 *  - verifies each non-revoked badge with the public half of the CURRENT
 *    signing key (the same key /trp/badges/:id/verify uses)
 *  - leaves every badge that verifies untouched
 *  - for one that fails, keeps its content exactly (Badge.id, badgeData.id,
 *    issuanceDate, role, images, description) and replaces only `proof`
 *  - never creates or deletes Badge rows, never touches Membership
 *
 * Dry run by default. Pass --apply to write.
 *   npx tsx scripts/reissue-invalid-badges.ts            # report only
 *   npx tsx scripts/reissue-invalid-badges.ts --apply    # re-sign failures
 *   ... --include-inactive                               # also badges whose membership isn't ACTIVE
 *
 * Needs the hub's production env (DATABASE_URL, RING_HUB_PRIVATE_KEY). Refuses
 * to run on an ephemeral key — re-signing with one would just break again on
 * the next restart. Idempotent: a second run finds nothing to do.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generateBadgeProof, verifyBadge, ThreadRingBadge } from '../src/utils/badge';
import { RING_HUB_PRIVATE_KEY, USING_EPHEMERAL_KEY } from '../src/utils/signing-key';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  const includeInactive = process.argv.includes('--include-inactive');

  if (USING_EPHEMERAL_KEY) {
    throw new Error('RING_HUB_PRIVATE_KEY is unset or invalid; refusing to re-sign with an ephemeral key.');
  }
  const publicKey = crypto.createPublicKey(RING_HUB_PRIVATE_KEY);

  const counts = { checked: 0, valid: 0, invalid: 0, resigned: 0, skippedInactive: 0, malformed: 0, failed: 0 };
  const BATCH_SIZE = 100;
  let cursor: string | undefined;

  for (;;) {
    const badges = await prisma.badge.findMany({
      where: { revokedAt: null },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      include: { membership: { select: { status: true, actorDid: true } } },
    });
    if (badges.length === 0) break;

    for (const row of badges) {
      counts.checked++;
      const data = row.badgeData as unknown as ThreadRingBadge;

      if (!data?.proof?.jws || !data.issuer?.id) {
        counts.malformed++;
        console.warn(`malformed badgeData, skipped: ${row.id}`);
        continue;
      }

      const { isValid } = await verifyBadge(data, publicKey);
      if (isValid) {
        counts.valid++;
        continue;
      }
      counts.invalid++;

      if (!includeInactive && row.membership.status !== 'ACTIVE') {
        counts.skippedInactive++;
        continue;
      }

      console.log(`${apply ? 're-signing' : 'would re-sign'}: ${row.id} (${data.threadRing?.ringSlug} / ${row.membership.actorDid})`);
      if (!apply) continue;

      try {
        const { proof: _oldProof, ...content } = data;
        const proof = await generateBadgeProof(content, RING_HUB_PRIVATE_KEY, data.issuer.id);
        await prisma.badge.update({
          where: { id: row.id },
          data: { badgeData: { ...content, proof } as any },
        });
        counts.resigned++;
      } catch (error) {
        counts.failed++;
        console.error(`failed: ${row.id}`, error);
      }
    }

    cursor = badges[badges.length - 1]!.id;
  }

  console.log(apply ? 'Applied.' : 'Dry run (pass --apply to write).', counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
