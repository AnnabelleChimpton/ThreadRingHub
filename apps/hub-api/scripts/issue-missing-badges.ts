/**
 * One-shot: issue the badge an ACTIVE membership should have but doesn't.
 *
 * From 2026-07-02 to 2026-11-16 prod ran on an ephemeral signing key
 * (RING_HUB_PRIVATE_KEY was set but not a base64 PKCS#8 PEM, so it failed to
 * load), and ephemeralBadgeIssuanceBlock() rightly withheld every badge: joins
 * succeeded with no badge, so residents had nothing to show in their settings.
 *
 * For each ACTIVE membership with no Badge row, this does what the join route
 * does (routes/membership.ts): generateBadge with the ring's current name,
 * images and the member's role, then the badge row and membership.badgeId in
 * one transaction. The badge is dated now: it's issued now.
 *
 *  - never touches a membership that already has a badge (revoked ones too:
 *    those are removals, and a rejoin replaces them)
 *  - never changes a membership's status, role or anything but badgeId
 *
 * Dry run by default. Pass --apply to write.
 *   npx tsx scripts/issue-missing-badges.ts            # report only
 *   npx tsx scripts/issue-missing-badges.ts --apply    # issue them
 *
 * Needs the hub's production env (DATABASE_URL, RING_HUB_PRIVATE_KEY, the hub
 * URL). Refuses to run on an ephemeral key. Idempotent: a second run finds
 * nothing to do. Undo: delete the Badge rows it prints and null those
 * memberships' badgeId.
 */
import { PrismaClient } from '@prisma/client';
import { config } from '../src/config';
import { generateBadge } from '../src/utils/badge';
import { RING_HUB_PRIVATE_KEY, USING_EPHEMERAL_KEY } from '../src/utils/signing-key';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');

  if (USING_EPHEMERAL_KEY) {
    throw new Error('RING_HUB_PRIVATE_KEY is unset or invalid; refusing to issue badges with an ephemeral key.');
  }

  const memberships = await prisma.membership.findMany({
    where: { status: 'ACTIVE', badge: { is: null } },
    orderBy: { joinedAt: 'asc' },
    select: {
      id: true,
      actorDid: true,
      joinedAt: true,
      role: { select: { name: true } },
      ring: { select: { slug: true, name: true, badgeImageUrl: true, badgeImageHighResUrl: true } },
    },
  });

  const counts = { missing: memberships.length, issued: 0, failed: 0 };
  console.log(`Hub URL: ${config.hubUrl}`);

  for (const membership of memberships) {
    const { ring } = membership;
    const role = membership.role?.name || 'member';
    console.log(
      `${apply ? 'issuing' : 'would issue'}: ${ring.slug} / ${membership.actorDid} (${role}, joined ${membership.joinedAt?.toISOString().slice(0, 10) ?? '?'})`
    );
    if (!apply) continue;

    try {
      const issued = await generateBadge(
        ring.slug,
        ring.name,
        membership.actorDid,
        role,
        RING_HUB_PRIVATE_KEY,
        config.hubUrl,
        ring.badgeImageUrl || undefined,
        ring.badgeImageHighResUrl || undefined
      );
      await prisma.$transaction([
        prisma.badge.create({
          data: { id: issued.id, membershipId: membership.id, badgeData: issued as any, issuedAt: new Date() },
        }),
        prisma.membership.update({
          where: { id: membership.id },
          data: { badgeId: issued.id },
        }),
      ]);
      counts.issued++;
      console.log(`  → ${issued.id}`);
    } catch (error) {
      counts.failed++;
      console.error(`failed: ${membership.id}`, error);
    }
  }

  console.log(apply ? 'Applied.' : 'Dry run (pass --apply to write).', counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
