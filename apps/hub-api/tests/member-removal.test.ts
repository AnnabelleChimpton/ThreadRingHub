/**
 * DELETE /trp/rings/:slug/members/:did and what it means for /trp/join,
 * against real Postgres: who may remove whom, what a removal records, and
 * that a removed member comes back only by invitation while one who left on
 * their own rejoins freely. HTTP signatures are stubbed: `x-test-actor` stands
 * in for a verified signer; DID resolution is stubbed too (ThreadStead's
 * federation suite covers both for real).
 */
import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/database/prisma';
import { DEFAULT_ROLES } from '../src/utils/default-roles';
import { config } from '../src/config';

jest.mock('../src/security/middleware', () => {
    const actual = jest.requireActual('../src/security/middleware');
    return {
        ...actual,
        authenticateActor: async (request: any) => {
            const did = request.headers['x-test-actor'];
            if (did) {
                request.actor = { did, verified: true, trusted: false, isAdmin: false };
            }
        },
    };
});
jest.mock('../src/security/did-resolver', () => ({
    ...jest.requireActual('../src/security/did-resolver'),
    resolveDID: async (did: string) => ({ id: did }),
}));
jest.mock('../src/services/profile-resolver', () => ({
    ...jest.requireActual('../src/services/profile-resolver'),
    validateProfileServiceEndpoint: () => ({ valid: true }),
    resolveActorProfile: async () => null,
}));

// eslint-disable-next-line import/first
import { ringManagementRoutes } from '../src/routes/ring-management';
// eslint-disable-next-line import/first
import { membershipRoutes } from '../src/routes/membership';

const OWNER = 'did:web:owner.removal.test';
const MOD = 'did:web:mod.removal.test';
const MOD2 = 'did:web:mod2.removal.test';
const MEMBER = 'did:web:member.removal.test';
const MEMBER2 = 'did:web:member2.removal.test';
const DIDS = [OWNER, MOD, MOD2, MEMBER, MEMBER2];

let app: FastifyInstance;
const slugs: string[] = [];

async function makeRing(slug: string) {
    slugs.push(slug);
    const ring = await prisma.ring.create({ data: { slug, name: slug, ownerDid: OWNER, joinPolicy: 'OPEN' } });
    const roles: Record<string, string> = {};
    for (const { name, permissions } of DEFAULT_ROLES) {
        const role = await prisma.ringRole.create({ data: { ringId: ring.id, name, permissions: [...permissions] } });
        roles[name] = role.id;
    }
    const join = (actorDid: string, role: string) =>
        prisma.membership.create({ data: { ringId: ring.id, actorDid, roleId: roles[role], status: 'ACTIVE', joinedAt: new Date() } });
    await join(OWNER, 'owner');
    await join(MOD, 'moderator');
    await join(MOD2, 'moderator');
    await join(MEMBER, 'member');
    await join(MEMBER2, 'member');
    return ring;
}

async function call(method: 'POST' | 'DELETE', url: string, actor: string, payload?: Record<string, unknown>) {
    const res = await app.inject({ method, url, payload, headers: { 'x-test-actor': actor } });
    return { status: res.statusCode, body: res.json() as any };
}
const remove = (slug: string, did: string, actor: string) =>
    call('DELETE', `/trp/rings/${slug}/members/${encodeURIComponent(did)}`, actor);
const join = (slug: string, actor: string) => call('POST', '/trp/join', actor, { ringSlug: slug });
const leave = (slug: string, actor: string) => call('POST', '/trp/leave', actor, { ringSlug: slug });
const invite = (slug: string, inviteeDid: string, actor: string) =>
    call('POST', `/trp/rings/${slug}/invite`, actor, { inviteeDid });

const membershipOf = (ringId: string, actorDid: string) =>
    prisma.membership.findUniqueOrThrow({ where: { ringId_actorDid: { ringId, actorDid } } });

beforeAll(async () => {
    app = Fastify();
    await app.register(membershipRoutes, { prefix: '/trp' });
    await app.register(ringManagementRoutes, { prefix: '/trp' });
    await app.ready();
});

afterAll(async () => {
    // Roles, memberships, badges, invitations and audit rows cascade with the ring.
    await prisma.ring.deleteMany({ where: { slug: { in: slugs } } });
    await prisma.actor.deleteMany({ where: { did: { in: DIDS } } });
    await app.close();
    await prisma.$disconnect();
});

describe('who may remove whom', () => {
    test('the owner removes a member, and the removal is recorded', async () => {
        const ring = await makeRing('removal-owner');
        const before = await membershipOf(ring.id, MEMBER);
        await prisma.badge.create({ data: { id: 'removal-owner-badge', membershipId: before.id, badgeData: { id: 'x' } } });

        const res = await remove(ring.slug, MEMBER, OWNER);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const after = await membershipOf(ring.id, MEMBER);
        expect(after.status).toBe('REVOKED');
        expect(after.removedBy).toBe(OWNER);
        expect(after.leftAt).not.toBeNull();

        const badge = await prisma.badge.findUniqueOrThrow({ where: { id: 'removal-owner-badge' } });
        expect(badge.revokedAt).not.toBeNull();
        expect(badge.revocationReason).toBe('Removed from ring');

        const audit = await prisma.auditLog.findMany({ where: { ringId: ring.id, action: 'membership.removed' } });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actorDid: OWNER, targetDid: MEMBER });
        expect(audit[0].metadata).toMatchObject({ membershipId: before.id, role: 'member', byRole: 'owner' });
    });

    test('the owner removes a moderator', async () => {
        const ring = await makeRing('removal-owner-mod');
        expect((await remove(ring.slug, MOD, OWNER)).status).toBe(200);
        expect((await membershipOf(ring.id, MOD)).status).toBe('REVOKED');
    });

    test('a moderator removes a plain member', async () => {
        const ring = await makeRing('removal-mod');
        expect((await remove(ring.slug, MEMBER, MOD)).status).toBe(200);
        expect((await membershipOf(ring.id, MEMBER)).removedBy).toBe(MOD);
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { ringId: ring.id, action: 'membership.removed' } });
        expect(audit.metadata).toMatchObject({ byRole: 'moderator' });
    });

    test('a moderator cannot remove another moderator or the owner', async () => {
        const ring = await makeRing('removal-mod-limits');
        expect((await remove(ring.slug, MOD2, MOD)).status).toBe(403);
        expect((await remove(ring.slug, OWNER, MOD)).status).toBe(403);
        expect((await membershipOf(ring.id, MOD2)).status).toBe('ACTIVE');
        expect((await membershipOf(ring.id, OWNER)).status).toBe('ACTIVE');
    });

    test('a plain member cannot remove anyone', async () => {
        const ring = await makeRing('removal-member');
        expect((await remove(ring.slug, MEMBER2, MEMBER)).status).toBe(403);
        expect((await membershipOf(ring.id, MEMBER2)).status).toBe('ACTIVE');
    });

    test('nobody removes the owner', async () => {
        const ring = await makeRing('removal-not-owner');
        expect((await remove(ring.slug, OWNER, OWNER)).status).toBe(403);
    });
});

describe('coming back', () => {
    test('a removed member cannot rejoin an open ring on their own', async () => {
        const ring = await makeRing('removal-rejoin');
        await remove(ring.slug, MEMBER, OWNER);

        const res = await join(ring.slug, MEMBER);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Removed');
        expect((await membershipOf(ring.id, MEMBER)).status).toBe('REVOKED');
    });

    test('an invitation lets a removed member back in, as a member who can leave and rejoin', async () => {
        const ring = await makeRing('removal-invite');
        await remove(ring.slug, MEMBER, MOD);

        expect((await invite(ring.slug, MEMBER, MOD)).status).toBe(200);
        const res = await join(ring.slug, MEMBER);
        expect(res.status).toBe(201);
        expect(res.body.membership.status).toBe('ACTIVE');
        expect((await membershipOf(ring.id, MEMBER)).removedBy).toBeNull();

        // Back to an ordinary member: leaving and rejoining needs no invite.
        expect((await leave(ring.slug, MEMBER)).status).toBe(200);
        expect((await join(ring.slug, MEMBER)).status).toBe(201);
    });

    test('a member who left on their own rejoins an open ring freely', async () => {
        const ring = await makeRing('removal-left');
        expect((await leave(ring.slug, MEMBER)).status).toBe(200);
        expect((await membershipOf(ring.id, MEMBER)).removedBy).toBeNull();

        const res = await join(ring.slug, MEMBER);
        expect(res.status).toBe(201);
        expect(res.body.membership.status).toBe('ACTIVE');
    });
});

describe('badge URLs', () => {
    test('the credential id is a /trp/badges URL, and the join response links to it', async () => {
        const ring = await makeRing('removal-badge');
        await prisma.membership.delete({ where: { ringId_actorDid: { ringId: ring.id, actorDid: MEMBER } } });

        const res = await join(ring.slug, MEMBER);
        expect(res.status).toBe(201);
        const { id, url } = res.body.badge;
        expect(url).toBe(id);
        expect(new URL(url).pathname).toMatch(/^\/trp\/badges\/[^/]+$/);

        const served = await app.inject({ method: 'GET', url: new URL(url).pathname });
        expect(served.statusCode).toBe(200);
        expect(served.json().badge.id).toBe(url);
        const verified = await app.inject({ method: 'POST', url: `${new URL(url).pathname}/verify` });
        expect(verified.json().isValid).toBe(true);
    });

    test('a badge issued under the old /badges/:id credential id is served by its short id', async () => {
        const ring = await makeRing('removal-old-badge');
        const membership = await membershipOf(ring.id, MEMBER);
        const oldId = `${config.hubUrl}/badges/old-short-id`;
        await prisma.badge.create({ data: { id: oldId, membershipId: membership.id, badgeData: { id: oldId } } });

        const served = await app.inject({ method: 'GET', url: '/trp/badges/old-short-id' });
        expect(served.statusCode).toBe(200);
        expect(served.json().badge.id).toBe(oldId);
    });
});
