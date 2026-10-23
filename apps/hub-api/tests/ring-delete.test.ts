/**
 * DELETE /trp/rings/:slug against real Postgres: who may delete, what goes
 * with the ring, and where its forks go. HTTP signatures are stubbed as in
 * ownership-transfer.test.ts: `x-test-actor` stands in for a verified signer
 * and `x-test-admin: 1` makes it a hub admin (ThreadStead's federation suite
 * covers real signatures).
 */
import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/database/prisma';
import { config } from '../src/config';
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
import { ringsRoutes } from '../src/routes/rings';

const OWNER = 'did:web:owner.delete.test';
const ALICE = 'did:web:alice.delete.test';
const BOB = 'did:web:bob.delete.test';
const ADMIN = 'did:web:admin.delete.test';
const STRANGER = 'did:web:stranger.delete.test';

let app: FastifyInstance;
let rootId: string;
const slugs: string[] = [];

/** A ring with the default roles and OWNER holding the owner role. */
async function makeRing(slug: string, parentId: string | null = rootId) {
    slugs.push(slug);
    const ring = await prisma.ring.create({ data: { slug, name: slug, ownerDid: OWNER, parentId } });
    const roles: Record<string, string> = {};
    for (const { name, permissions } of DEFAULT_ROLES) {
        const role = await prisma.ringRole.create({ data: { ringId: ring.id, name, permissions: [...permissions] } });
        roles[name] = role.id;
    }
    await prisma.membership.create({
        data: { ringId: ring.id, actorDid: OWNER, roleId: roles.owner, status: 'ACTIVE', joinedAt: new Date() },
    });
    return { ring, roles };
}

async function del(slug: string, actor?: string, admin = false) {
    const headers: Record<string, string> = {};
    if (actor) headers['x-test-actor'] = actor;
    if (admin) headers['x-test-admin'] = '1';
    const res = await app.inject({ method: 'DELETE', url: `/trp/rings/${slug}`, headers });
    return { status: res.statusCode, body: res.body };
}

const parentOf = async (id: string) => (await prisma.ring.findUnique({ where: { id }, select: { parentId: true } }))?.parentId;

beforeAll(async () => {
    app = Fastify();
    await app.register(ringsRoutes, { prefix: '/trp' });
    await app.ready();

    slugs.push(config.rings.rootSlug);
    const root = await prisma.ring.create({ data: { slug: config.rings.rootSlug, name: 'Root', ownerDid: ADMIN } });
    rootId = root.id;
});

afterAll(async () => {
    // Children first: Ring.parentId would otherwise point at a deleted root.
    await prisma.ring.deleteMany({ where: { slug: { in: slugs }, NOT: { slug: config.rings.rootSlug } } });
    await prisma.ring.deleteMany({ where: { slug: config.rings.rootSlug } });
    await app.close();
    await prisma.$disconnect();
});

describe('DELETE /trp/rings/:slug', () => {
    it('the owner deletes their ring: 204 with no body, and its memberships, PostRefs and invitations go with it', async () => {
        const { ring, roles } = await makeRing('delete-basic');
        await prisma.membership.create({
            data: { ringId: ring.id, actorDid: ALICE, roleId: roles.member, status: 'PENDING' },
        });
        await prisma.postRef.create({
            data: { ringId: ring.id, actorDid: OWNER, uri: 'https://delete.test/p/1', digest: 'sha256:x', submittedBy: OWNER, status: 'ACCEPTED' },
        });
        await prisma.invitation.create({
            data: { ringId: ring.id, inviteeDid: BOB, inviterDid: OWNER, expiresAt: new Date(Date.now() + 86_400_000) },
        });

        const { status, body } = await del('delete-basic', OWNER);

        expect(status).toBe(204);
        expect(body).toBe('');
        expect(await prisma.ring.findUnique({ where: { id: ring.id } })).toBeNull();
        expect(await prisma.membership.count({ where: { ringId: ring.id } })).toBe(0);
        expect(await prisma.postRef.count({ where: { ringId: ring.id } })).toBe(0);
        expect(await prisma.invitation.count({ where: { ringId: ring.id } })).toBe(0);
        expect(await prisma.ringRole.count({ where: { ringId: ring.id } })).toBe(0);
    });

    it("moves the ring's forks up to its parent, and leaves its grandchildren where they are", async () => {
        const { ring: parent } = await makeRing('delete-parent');
        const { ring: middle } = await makeRing('delete-middle', parent.id);
        const { ring: forkA } = await makeRing('delete-fork-a', middle.id);
        const { ring: forkB } = await makeRing('delete-fork-b', middle.id);
        const { ring: grandchild } = await makeRing('delete-grandchild', forkA.id);

        expect((await del('delete-middle', OWNER)).status).toBe(204);

        expect(await parentOf(forkA.id)).toBe(parent.id);
        expect(await parentOf(forkB.id)).toBe(parent.id);
        expect(await parentOf(grandchild.id)).toBe(forkA.id);
        expect(await parentOf(parent.id)).toBe(rootId);
    });

    it('moves the forks of a parentless ring to the root', async () => {
        const { ring: orphan } = await makeRing('delete-orphan', null);
        const { ring: fork } = await makeRing('delete-orphan-fork', orphan.id);

        expect((await del('delete-orphan', OWNER)).status).toBe(204);

        expect(await parentOf(fork.id)).toBe(rootId);
    });

    it('refuses the root ring, even for a hub admin', async () => {
        const { status, body } = await del(config.rings.rootSlug, ADMIN, true);
        expect(status).toBe(400);
        expect(JSON.parse(body).message).toMatch(/root ring cannot be deleted/);
        expect(await prisma.ring.findUnique({ where: { id: rootId } })).not.toBeNull();
    });

    it('a member without delete_ring, or a stranger, gets 403 and nothing changes', async () => {
        const { ring, roles } = await makeRing('delete-not-owner');
        for (const [did, role] of [[ALICE, 'member'], [BOB, 'moderator']] as const) {
            await prisma.membership.create({
                data: { ringId: ring.id, actorDid: did, roleId: roles[role], status: 'ACTIVE', joinedAt: new Date() },
            });
        }
        for (const actor of [ALICE, BOB, STRANGER]) {
            expect((await del('delete-not-owner', actor)).status).toBe(403);
        }
        expect(await prisma.ring.findUnique({ where: { id: ring.id } })).not.toBeNull();
    });

    it('an owner who has already left can no longer delete it; a hub admin can', async () => {
        const { ring } = await makeRing('delete-owner-left');
        await prisma.membership.updateMany({ where: { ringId: ring.id, actorDid: OWNER }, data: { status: 'REVOKED' } });

        expect((await del('delete-owner-left', OWNER)).status).toBe(403);
        expect((await del('delete-owner-left', ADMIN, true)).status).toBe(204);
        expect(await prisma.ring.findUnique({ where: { id: ring.id } })).toBeNull();
    });

    it('answers 404 for a ring that is not there, to anyone signed (ThreadStead reads it as already gone)', async () => {
        expect((await del('delete-no-such-ring', ADMIN, true)).status).toBe(404);
        expect((await del('delete-no-such-ring', OWNER)).status).toBe(404);
    });

    it('refuses an unsigned call', async () => {
        await makeRing('delete-unsigned');
        expect((await del('delete-unsigned')).status).toBe(403);
        expect(await prisma.ring.findUnique({ where: { slug: 'delete-unsigned' } })).not.toBeNull();
    });
});
