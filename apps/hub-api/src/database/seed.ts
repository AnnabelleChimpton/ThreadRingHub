import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

// Load environment variables
loadEnv();

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Clean existing data
  await prisma.auditLog.deleteMany();
  await prisma.postRef.deleteMany();
  await prisma.challenge.deleteMany();
  await prisma.block.deleteMany();
  await prisma.badge.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.ringRole.deleteMany();
  await prisma.ring.deleteMany();
  await prisma.httpSignature.deleteMany();
  await prisma.actor.deleteMany();

  console.log('🧹 Cleaned existing data');

  // Create some actors
  const actors = await Promise.all([
    prisma.actor.create({
      data: {
        did: 'did:web:localhost:3100:actors:alice',
        name: 'Alice',
        type: 'USER',
        instanceUrl: 'http://localhost:3100',
        verified: true,
        trusted: true,
      },
    }),
    prisma.actor.create({
      data: {
        did: 'did:web:localhost:3100:actors:bob',
        name: 'Bob',
        type: 'USER',
        instanceUrl: 'http://localhost:3100',
        verified: true,
        trusted: true,
      },
    }),
    prisma.actor.create({
      data: {
        did: 'did:web:localhost:3100:actors:charlie',
        name: 'Charlie',
        type: 'USER',
        instanceUrl: 'http://localhost:3100',
        verified: false,
        trusted: false,
      },
    }),
  ]);

  console.log(`✅ Created ${actors.length} actors`);

  // Create The Spool (root ring)
  const spool = await prisma.ring.create({
    data: {
      slug: 'spool',
      name: 'The Spool',
      description: 'The universal root of all ThreadRings - where all communities connect',
      visibility: 'PUBLIC',
      joinPolicy: 'OPEN',
      postPolicy: 'OPEN',
      ownerDid: 'did:web:localhost:3100',
      curatorNote: 'Welcome to The Spool! This is the root of the ThreadRing genealogy tree.',
      metadata: {
        isRoot: true,
        createdBy: 'system',
      },
    },
  });

  console.log('✅ Created The Spool (root ring)');

  // Create some rings with genealogy
  const techRing = await prisma.ring.create({
    data: {
      slug: 'sustainable-tech',
      name: 'Sustainable Tech',
      description: 'Discussing sustainable technology and green computing',
      visibility: 'PUBLIC',
      joinPolicy: 'OPEN',
      postPolicy: 'MEMBERS',
      ownerDid: actors[0].did,
      parentId: spool.id,
      curatorNote: 'Share your sustainable tech projects and ideas!',
      metadata: {
        topics: ['sustainability', 'technology', 'green-computing'],
      },
    },
  });

  const solarRing = await prisma.ring.create({
    data: {
      slug: 'solar-innovation',
      name: 'Solar Innovation',
      description: 'Focused on solar panel research and photovoltaic breakthroughs',
      visibility: 'PUBLIC',
      joinPolicy: 'APPLICATION',
      postPolicy: 'CURATED',
      ownerDid: actors[1].did,
      parentId: techRing.id,
      curatorNote: 'High-quality solar research and innovation discussion',
      metadata: {
        topics: ['solar', 'photovoltaic', 'renewable-energy'],
      },
    },
  });

  const mobilityRing = await prisma.ring.create({
    data: {
      slug: 'urban-mobility',
      name: 'Urban Mobility',
      description: 'City transportation solutions and sustainable transit',
      visibility: 'PUBLIC',
      joinPolicy: 'OPEN',
      postPolicy: 'MEMBERS',
      ownerDid: actors[0].did,
      parentId: techRing.id,
      curatorNote: 'Discuss urban transportation challenges and solutions',
      metadata: {
        topics: ['transportation', 'cities', 'mobility'],
      },
    },
  });

  const privateRing = await prisma.ring.create({
    data: {
      slug: 'beta-testers',
      name: 'Beta Testers',
      description: 'Private ring for beta testing new features',
      visibility: 'PRIVATE',
      joinPolicy: 'INVITATION',
      postPolicy: 'MEMBERS',
      ownerDid: actors[0].did,
      curatorNote: 'Beta testing group - invitation only',
      metadata: {
        maxMembers: 50,
      },
    },
  });

  console.log('✅ Created sample rings with genealogy');

  // Create roles for rings
  const roles = await Promise.all([
    prisma.ringRole.create({
      data: {
        ringId: techRing.id,
        name: 'member',
        permissions: ['view_content', 'submit_posts'],
      },
    }),
    prisma.ringRole.create({
      data: {
        ringId: techRing.id,
        name: 'moderator',
        permissions: ['moderate_posts', 'manage_members', 'update_ring_info'],
      },
    }),
    prisma.ringRole.create({
      data: {
        ringId: techRing.id,
        name: 'curator',
        permissions: ['moderate_posts', 'manage_members', 'update_ring_info', 'manage_roles'],
      },
    }),
  ]);

  console.log('✅ Created ring roles');

  // Create memberships
  const memberships = await Promise.all([
    // Alice is owner of techRing and mobilityRing
    prisma.membership.create({
      data: {
        ringId: techRing.id,
        actorDid: actors[0].did,
        status: 'ACTIVE',
        roleId: roles[2].id, // curator role
      },
    }),
    // Bob is member of techRing and owner of solarRing
    prisma.membership.create({
      data: {
        ringId: techRing.id,
        actorDid: actors[1].did,
        status: 'ACTIVE',
        roleId: roles[1].id, // moderator role
      },
    }),
    prisma.membership.create({
      data: {
        ringId: solarRing.id,
        actorDid: actors[1].did,
        status: 'ACTIVE',
      },
    }),
    // Charlie has pending membership
    prisma.membership.create({
      data: {
        ringId: solarRing.id,
        actorDid: actors[2].did,
        status: 'PENDING',
      },
    }),
  ]);

  console.log(`✅ Created ${memberships.length} memberships`);

  // Create some post references
  const posts = await Promise.all([
    prisma.postRef.create({
      data: {
        ringId: techRing.id,
        actorDid: actors[0].did,
        uri: 'https://example.com/posts/1',
        digest: 'sha256:abcd1234',
        submittedBy: actors[0].did,
        status: 'ACCEPTED',
        metadata: {
          title: 'New Solar Panel Efficiency Record',
          excerpt: 'Researchers achieve 47% efficiency...',
        },
      },
    }),
    prisma.postRef.create({
      data: {
        ringId: techRing.id,
        actorDid: actors[1].did,
        uri: 'https://example.com/posts/2',
        digest: 'sha256:efgh5678',
        submittedBy: actors[1].did,
        status: 'ACCEPTED',
        pinned: true,
        metadata: {
          title: 'Electric Bus Fleet Deployment Guide',
          excerpt: 'Complete guide for cities looking to electrify...',
        },
      },
    }),
    prisma.postRef.create({
      data: {
        ringId: solarRing.id,
        actorDid: actors[2].did,
        uri: 'https://example.com/posts/3',
        digest: 'sha256:ijkl9012',
        submittedBy: actors[2].did,
        status: 'PENDING',
        metadata: {
          title: 'DIY Solar Installation Tips',
        },
      },
    }),
  ]);

  console.log(`✅ Created ${posts.length} post references`);

  // Create a challenge
  const challenge = await prisma.challenge.create({
    data: {
      ringId: techRing.id,
      title: 'Share Your Green Tech Project',
      prompt: 'What sustainable technology project are you working on? Share your ideas and progress!',
      createdBy: actors[0].did,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      active: true,
    },
  });

  console.log('✅ Created challenge');

  // Create audit logs
  const auditLogs = await Promise.all([
    prisma.auditLog.create({
      data: {
        ringId: techRing.id,
        action: 'ring.created',
        actorDid: actors[0].did,
        metadata: {
          ringName: 'Sustainable Tech',
        },
      },
    }),
    prisma.auditLog.create({
      data: {
        ringId: techRing.id,
        action: 'member.joined',
        actorDid: actors[1].did,
        targetDid: actors[1].did,
        metadata: {
          role: 'moderator',
        },
      },
    }),
    prisma.auditLog.create({
      data: {
        ringId: techRing.id,
        action: 'post.accepted',
        actorDid: actors[0].did,
        targetDid: actors[1].did,
        metadata: {
          postUri: 'https://example.com/posts/2',
        },
      },
    }),
  ]);

  console.log(`✅ Created ${auditLogs.length} audit log entries`);

  console.log('🎉 Seed completed successfully!');
  console.log('');
  console.log('Sample users:');
  console.log('  - Alice (did:web:localhost:3100:actors:alice) - Ring owner');
  console.log('  - Bob (did:web:localhost:3100:actors:bob) - Moderator');
  console.log('  - Charlie (did:web:localhost:3100:actors:charlie) - Pending member');
  console.log('');
  console.log('Sample rings:');
  console.log('  - /spool (root)');
  console.log('  - /sustainable-tech');
  console.log('  - /solar-innovation');
  console.log('  - /urban-mobility');
  console.log('  - /beta-testers (private)');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });