/**
 * POST /trp/rings/:slug/transfer-ownership, and the owner-role rules around
 * it in PUT /trp/rings/:slug/members/:did and POST /trp/leave, against real
 * Postgres. HTTP signatures are stubbed: `x-test-actor` stands in for a
 * verified signer and `x-test-admin: 1` makes it a hub admin (ThreadStead's
 * federation suite covers real signatures).
 */
import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/database/prisma';
import { DEFAULT_ROLES } from '../src/utils/default-roles';

jest.mock('../src/security/middleware', () => {
    const actual = jest.requireActual('../src/security/middleware');
    return {
        ...actual,
        authenticateActor: async (request: any) => {
            const did = request.headers['x-test-actor'];
            if (did) {
                request.actor = { did, verified: true, trusted: false, isAdmin: request.headers['x-test-admin'] === '1' };
            }
        },
    };
});

// eslint-disable-next-line import/first
import { ringManagementRoutes } from '../src/routes/ring-management';
// eslint-disable-next-line import/first
import { membershipRoutes } from '../src/routes/membership';

const OWNER = 'did:web:owner.transfer.test';
const ALICE = 'did:web:alice.transfer.test';
const BOB = 'did:web:bob.transfer.test';
const PENDING_PAT = 'did:web:pat.transfer.test';
const ADMIN = 'did:web:admin.transfer.test';
const STRANGER = 'did:web:stranger.transfer.test';

let app: FastifyInstance;
const slugs: string[] = [];

/** A ring with the default roles; OWNER holds the owner role unless `ownerMember` is false. */
async function makeRing(slug: string, opts: { ownerMember?: boolean } = {}) {
    slugs.push(slug);
    const ring = await prisma.ring.create({ data: { slug, name: slug, ownerDid: OWNER } });
    const roles: Record<string, string> = {};
    for (const { name, permissions } of DEFAULT_ROLES) {
        const role = await prisma.ringRole.create({ data: { ringId: ring.id, name, permissions: [...permissions] } });
        roles[name] = role.id;
    }
    const join = (actorDid: string, role: string, status: 'ACTIVE' | 'PENDING' = 'ACTIVE') =>
        prisma.membership.create({ data: { ringId: ring.id, actorDid, roleId: roles[role], status, joinedAt: new Date() } });
    if (opts.ownerMember !== false) await join(OWNER, 'owner');
    await join(ALICE, 'member');
    await join(BOB, 'moderator');
    await join(PENDING_PAT, 'member', 'PENDING');
    return { ring, roles };
}

async function transfer(slug: string, body: Record<string, unknown>, actor?: string, admin = false) {
    const headers: Record<string, string> = {};
    if (actor) headers['x-test-actor'] = actor;
    if (admin) headers['x-test-admin'] = '1';
    const res = await app.inject({ method: 'POST', url: `/trp/rings/${slug}/transfer-ownership`, payload: body, headers });
    return { status: res.statusCode, body: res.json() as any };
}

async function roleOf(ringId: string, actorDid: string) {
    const membership = await prisma.membership.findFirst({
        where: { ringId, actorDid },
        include: { role: { select: { name: true } } },
    });
    return membership?.role?.name ?? null;
}

beforeAll(async () => {
    app = Fastify();
    await app.register(ringManagementRoutes, { prefix: '/trp' });
    await app.register(membershipRoutes, { prefix: '/trp' });
    await app.ready();
});

afterAll(async () => {
    // Roles, memberships, blocks and audit rows cascade with the ring.
    await prisma.ring.deleteMany({ where: { slug: { in: slugs } } });
    await app.close();
    await prisma.$disconnect();
});

describe('POST /trp/rings/:slug/transfer-ownership', () => {
    it('the owner hands the ring to a member: ownerDid and roles move together, with an audit row', async () => {
        const { ring } = await makeRing('transfer-basic');

        const { status, body } = await transfer('transfer-basic', { newOwnerDid: ALICE, reason: 'moving on' }, OWNER);

        expect(status).toBe(200);
        expect(body).toEqual({
            message: 'Ownership transferred',
            ring: { slug: 'transfer-basic', ownerDid: ALICE },
            previousOwnerDid: OWNER,
            newOwnerDid: ALICE,
            byAdmin: false,
            transferredAt: expect.any(String),
        });
        expect(Number.isNaN(Date.parse(body.transferredAt))).toBe(false);

        const after = await prisma.ring.findUnique({ where: { id: ring.id } });
        expect(after!.ownerDid).toBe(ALICE);
        expect(await roleOf(ring.id, ALICE)).toBe('owner');
        expect(await roleOf(ring.id, OWNER)).toBe('member');
        expect(await roleOf(ring.id, BOB)).toBe('moderator');

        const audit = await prisma.auditLog.findMany({ where: { ringId: ring.id, action: 'ring.ownership_transferred' } });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
            actorDid: OWNER,
            targetDid: ALICE,
            metadata: { previousOwnerDid: OWNER, newOwnerDid: ALICE, byAdmin: false, reason: 'moving on' },
        });
    });

    it('afterwards the old owner can leave and the new owner cannot', async () => {
        const leave = async (actor: string) => {
            const res = await app.inject({
                method: 'POST',
                url: '/trp/leave',
                payload: { ringSlug: 'transfer-basic' },
                headers: { 'x-test-actor': actor },
            });
            return res.statusCode;
        };
        expect(await leave(ALICE)).toBe(400); // "Transfer ownership required"
        expect(await leave(OWNER)).toBe(200);
    });

    it('the old owner can no longer transfer it', async () => {
        const { status } = await transfer('transfer-basic', { newOwnerDid: BOB }, OWNER);
        expect(status).toBe(403);
    });

    it('a member who is not the owner gets 403 and nothing changes', async () => {
        const { ring } = await makeRing('transfer-not-owner');
        const { status, body } = await transfer('transfer-not-owner', { newOwnerDid: ALICE }, BOB);
        expect(status).toBe(403);
        expect(body.message).toMatch(/owner or a hub admin/);
        expect((await prisma.ring.findUnique({ where: { id: ring.id } }))!.ownerDid).toBe(OWNER);
        expect(await roleOf(ring.id, OWNER)).toBe('owner');
    });

    it('a hub admin can transfer a ring whose owner is gone', async () => {
        const { ring } = await makeRing('transfer-admin');
        const { status, body } = await transfer('transfer-admin', { newOwnerDid: BOB, reason: 'owner banned' }, ADMIN, true);
        expect(status).toBe(200);
        expect(body).toMatchObject({ previousOwnerDid: OWNER, newOwnerDid: BOB, byAdmin: true });
        expect(await roleOf(ring.id, BOB)).toBe('owner');
        expect(await roleOf(ring.id, OWNER)).toBe('member');
        const audit = await prisma.auditLog.findFirst({ where: { ringId: ring.id, action: 'ring.ownership_transferred' } });
        expect(audit).toMatchObject({ actorDid: ADMIN, targetDid: BOB, metadata: { byAdmin: true, reason: 'owner banned' } });
    });

    it('works when the previous owner has no membership row', async () => {
        const { ring } = await makeRing('transfer-ownerless', { ownerMember: false });
        const { status } = await transfer('transfer-ownerless', { newOwnerDid: ALICE }, ADMIN, true);
        expect(status).toBe(200);
        expect((await prisma.ring.findUnique({ where: { id: ring.id } }))!.ownerDid).toBe(ALICE);
        expect(await roleOf(ring.id, ALICE)).toBe('owner');
    });

    it('refuses a new owner who is not an ACTIVE member', async () => {
        await makeRing('transfer-not-member');
        for (const did of [STRANGER, PENDING_PAT]) {
            const { status, body } = await transfer('transfer-not-member', { newOwnerDid: did }, OWNER);
            expect(status).toBe(400);
            expect(body.error).toBe('Not a member');
        }
    });

    it('refuses a new owner who is blocked from the ring', async () => {
        const { ring } = await makeRing('transfer-blocked');
        await prisma.block.create({ data: { ringId: ring.id, targetDid: ALICE, targetType: 'USER', blockedBy: OWNER } });
        const { status, body } = await transfer('transfer-blocked', { newOwnerDid: ALICE }, OWNER);
        expect(status).toBe(400);
        expect(body.error).toBe('Blocked');
        expect(await roleOf(ring.id, ALICE)).toBe('member');
    });

    it('refuses handing the ring to its current owner', async () => {
        await makeRing('transfer-self');
        const { status, body } = await transfer('transfer-self', { newOwnerDid: OWNER }, OWNER);
        expect(status).toBe(400);
        expect(body.error).toBe('Already owner');
    });

    it('answers 404 for an unknown ring and 400 without newOwnerDid', async () => {
        expect((await transfer('no-such-ring', { newOwnerDid: ALICE }, OWNER)).status).toBe(404);
        await makeRing('transfer-bad-body');
        expect((await transfer('transfer-bad-body', {}, OWNER)).status).toBe(400);
        expect((await transfer('transfer-bad-body', { newOwnerDid: '' }, OWNER)).status).toBe(400);
    });

    it('does not move a missing-role ring halfway', async () => {
        const { ring, roles } = await makeRing('transfer-no-member-role');
        // Detach then drop the member role, so only the owner and moderator roles remain.
        await prisma.membership.updateMany({ where: { roleId: roles.member }, data: { roleId: roles.moderator } });
        await prisma.ringRole.delete({ where: { id: roles.member } });
        const { status } = await transfer('transfer-no-member-role', { newOwnerDid: ALICE }, OWNER);
        expect(status).toBe(500);
        expect((await prisma.ring.findUnique({ where: { id: ring.id } }))!.ownerDid).toBe(OWNER);
    });
});

describe('PUT /trp/rings/:slug/members/:did and the owner role', () => {
    async function setRole(slug: string, did: string, role: string) {
        const res = await app.inject({
            method: 'PUT',
            url: `/trp/rings/${slug}/members/${encodeURIComponent(did)}`,
            payload: { role },
            headers: { 'x-test-actor': OWNER },
        });
        return { status: res.statusCode, body: res.json() as any };
    }

    it('will not hand out the owner role (that is a transfer)', async () => {
        const { ring } = await makeRing('role-owner-guard');
        const { status, body } = await setRole('role-owner-guard', ALICE, 'owner');
        expect(status).toBe(400);
        expect(body.error).toBe('Cannot assign owner');
        expect(await roleOf(ring.id, ALICE)).toBe('member');
    });

    it('still changes other roles', async () => {
        const { ring } = await makeRing('role-moderator');
        expect((await setRole('role-moderator', ALICE, 'moderator')).status).toBe(200);
        expect(await roleOf(ring.id, ALICE)).toBe('moderator');
    });
});
