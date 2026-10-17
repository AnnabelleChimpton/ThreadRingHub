/**
 * One-shot: give existing rings the `moderator` (and, if missing, `member`)
 * role from DEFAULT_ROLES (audit 0.8).
 *
 * Rings created through POST /trp/rings or /trp/fork before DEFAULT_ROLES only
 * got owner + member, so promoting anyone to moderator 400'd ("Role not found
 * in this ring"). New rings get all three roles; this catches up the rest.
 *
 * Insert-only: never modifies or deletes an existing role, never touches a
 * membership. The report first lists any moderator roles that already exist
 * (and their permissions), so you can see what prod already has.
 *
 * Dry run by default. Pass --apply to write.
 *   npx tsx scripts/backfill-default-roles.ts
 *   npx tsx scripts/backfill-default-roles.ts --apply
 *
 * Idempotent: a second run finds nothing to insert.
 * Undo (if ever needed): delete the inserted moderator rows that no membership
 * references — the script prints every ring it touched.
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES } from '../src/utils/default-roles';

const prisma = new PrismaClient();
const BACKFILLED_ROLES = DEFAULT_ROLES.filter((role) => role.name === 'moderator' || role.name === 'member');

async function main() {
  const apply = process.argv.includes('--apply');

  const existingModerators = await prisma.ringRole.findMany({
    where: { name: 'moderator' },
    select: { permissions: true, ring: { select: { slug: true } }, _count: { select: { members: true } } },
  });
  console.log(`Rings that already have a moderator role: ${existingModerators.length}`);
  for (const role of existingModerators) {
    console.log(`  ${role.ring.slug}: ${JSON.stringify(role.permissions)} (${role._count.members} memberships)`);
  }

  const rings = await prisma.ring.findMany({
    select: { id: true, slug: true, roles: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  let inserted = 0;
  for (const ring of rings) {
    const have = new Set(ring.roles.map((role) => role.name));
    const missing = BACKFILLED_ROLES.filter((role) => !have.has(role.name));
    if (missing.length === 0) continue;

    console.log(`${apply ? 'adding' : 'would add'} ${missing.map((role) => role.name).join(', ')} → ${ring.slug}`);
    if (!apply) continue;

    for (const role of missing) {
      await prisma.ringRole.create({
        data: { ringId: ring.id, name: role.name, permissions: [...role.permissions] },
      });
      inserted++;
    }
  }

  console.log(apply ? `Applied: inserted ${inserted} roles.` : 'Dry run (pass --apply to write).', `${rings.length} rings checked.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
