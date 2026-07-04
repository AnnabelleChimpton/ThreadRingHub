/**
 * Minimal deterministic seed for integration tests.
 *
 * Creates exactly what an external client (e.g. ThreadStead's federation
 * suite) needs to exercise the core flows against a freshly-pushed schema:
 *
 *  - the root ring ("spool") so genealogy/config defaults hold
 *  - one test ring (open join, members-only posting) with a "member" role,
 *    since /trp/join 403s on rings without roles
 *  - a pre-verified Actor + cached HttpSignature row for the test client's
 *    signing key, so requests authenticate without any did:web resolution
 *
 * Parameterized by env so the caller owns the keypair:
 *   TEST_ACTOR_DID          e.g. did:web:threadstead.test:users:itest1
 *   TEST_ACTOR_PUBKEY_B64   base64 of the raw 32-byte Ed25519 public key
 *   TEST_RING_SLUG          default "itest-ring"
 *
 * Idempotent: safe to re-run against the same database.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const actorDid = process.env.TEST_ACTOR_DID;
  const publicKeyB64 = process.env.TEST_ACTOR_PUBKEY_B64;
  const ringSlug = process.env.TEST_RING_SLUG || 'itest-ring';

  if (!actorDid || !publicKeyB64) {
    throw new Error('TEST_ACTOR_DID and TEST_ACTOR_PUBKEY_B64 are required');
  }

  const ownerDid = 'did:web:itest-owner.invalid';

  const spool = await prisma.ring.upsert({
    where: { slug: 'spool' },
    update: {},
    create: {
      slug: 'spool',
      name: 'The Spool',
      description: 'Root ring (integration seed)',
      visibility: 'PUBLIC',
      joinPolicy: 'OPEN',
      postPolicy: 'OPEN',
      ownerDid,
      metadata: { isRoot: true },
    },
  });

  const ring = await prisma.ring.upsert({
    where: { slug: ringSlug },
    update: {},
    create: {
      slug: ringSlug,
      name: 'Integration Test Ring',
      description: 'Ring used by the federation integration suite',
      visibility: 'PUBLIC',
      joinPolicy: 'OPEN',
      postPolicy: 'MEMBERS',
      ownerDid,
      parentId: spool.id,
    },
  });

  for (const [name, permissions] of [
    ['member', ['post']],
    ['owner', ['post', 'moderate', 'manage_ring', 'manage_members']],
  ] as const) {
    await prisma.ringRole.upsert({
      where: { ringId_name: { ringId: ring.id, name } },
      update: {},
      create: { ringId: ring.id, name, permissions: [...permissions] },
    });
  }

  await prisma.actor.upsert({
    where: { did: actorDid },
    update: { verified: true },
    create: {
      did: actorDid,
      name: 'Integration Test Actor',
      type: 'USER',
      publicKey: publicKeyB64,
      verified: true,
      trusted: false,
    },
  });

  // Pre-cache the signing key with a far-future expiry so verification never
  // attempts did:web resolution (the test DID is intentionally unresolvable).
  const keyId = `${actorDid}#key-1`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.httpSignature.upsert({
    where: { keyId },
    update: { publicKey: publicKeyB64, expiresAt },
    create: { keyId, publicKey: publicKeyB64, actorDid, expiresAt },
  });

  console.log(
    JSON.stringify({ seeded: true, ringSlug, actorDid, spoolId: spool.id, ringId: ring.id })
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
