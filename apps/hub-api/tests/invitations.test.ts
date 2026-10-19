/**
 * POST /trp/rings/:slug/invite against real Postgres: when a curator may
 * invite someone again. HTTP signatures are stubbed: `x-test-actor` stands in
 * for a verified signer (ThreadStead's federation suite covers real
 * signatures and the real join/leave round trip).
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
                request.actor = { did, verified: true, trusted: false, isAdmin: false };
            }
        },
    };
});

// eslint-disable-next-line import/first
import { ringManagementRoutes } from '../src/routes/ring-management';

const OWNER = 'did:web:owner.invite.test';
const MOD = 'did:web:mod.invite.test';
const MEMBER = 'did:web:member.invite.test';
const GUEST = 'did:web:guest.invite.test';

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const slugs: string[] = [];

async function makeRing(slug: string) {
    slugs.push(slug);
    const ring = await prisma.ring.create({ data: { slug, name: slug, ownerDid: OWNER, joinPolicy: 'INVITATION' } });
    const roles: Record<string, string> = {};
    for (const { name, permissions } of DEFAULT_ROLES) {
        const role = await prisma.ringRole.create({ data: { ringId: ring.id, name, permissions: [...permissions] } });
        roles[name] = role.id;
    }
    const join = (actorDid: string, role: string) =>
        prisma.membership.create({ data: { ringId: ring.id, actorDid, roleId: roles[role], status: 'ACTIVE', joinedAt: new Date() } });
    await join(OWNER, 'owner');
    await join(MOD, 'moderator');
    await join(MEMBER, 'member');
    return ring;
}

async function invite(slug: string, body: Record<string, unknown>, actor: string) {
    const res = await app.inject({
        method: 'POST',
        url: `/trp/rings/${slug}/invite`,
        payload: body,
        headers: { 'x-test-actor': actor },
    });
    return { status: res.statusCode, body: res.json() as any };
}

function invitationRows(ringId: string) {
    return prisma.invitation.findMany({ where: { ringId, inviteeDid: GUEST } });
}

beforeAll(async () => {
    app = Fastify();
    await app.register(ringManagementRoutes, { prefix: '/trp' });
    await app.ready();
});

afterAll(async () => {
    // Roles, memberships and invitations cascade with the ring.
    await prisma.ring.deleteMany({ where: { slug: { in: slugs } } });
    await app.close();
    await prisma.$disconnect();
});

describe('POST /trp/rings/:slug/invite', () => {
    it('creates a 7-day PENDING invitation and replies with the shape ThreadStead validates', async () => {
        const ring = await makeRing('invite-basic');

        const before = Date.now();
        const { status, body } = await invite('invite-basic', { inviteeDid: GUEST }, OWNER);

        expect(status).toBe(200);
        expect(body).toEqual({
            success: true,
            invitation: {
                id: expect.any(String),
                ringSlug: 'invite-basic',
                inviteeDid: GUEST,
                inviterDid: OWNER,
                status: 'PENDING',
                createdAt: expect.any(String),
                expiresAt: expect.any(String),
            },
        });
        const expires = Date.parse(body.invitation.expiresAt);
        expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY - 1000);
        expect(expires).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000);
        expect(await invitationRows(ring.id)).toHaveLength(1);
    });

    it('refuses a second invite while the first is still live', async () => {
        const ring = await makeRing('invite-live');
        const first = await invite('invite-live', { inviteeDid: GUEST }, OWNER);
        expect(first.status).toBe(200);

        const second = await invite('invite-live', { inviteeDid: GUEST }, MOD);

        expect(second.status).toBe(400);
        expect(second.body).toEqual({
            error: 'Invitation exists',
            message: 'User already has a pending invitation to this ring',
        });
        const rows = await invitationRows(ring.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].inviterDid).toBe(OWNER);
    });

    it('re-invites after an unused invitation ran out, reusing the row', async () => {
        const ring = await makeRing('invite-expired');
        const old = await prisma.invitation.create({
            data: {
                ringId: ring.id,
                inviteeDid: GUEST,
                inviterDid: OWNER,
                status: 'PENDING',
                createdAt: new Date(Date.now() - 10 * DAY),
                expiresAt: new Date(Date.now() - 3 * DAY),
            },
        });

        const { status, body } = await invite('invite-expired', { inviteeDid: GUEST }, MOD);

        expect(status).toBe(200);
        expect(body.invitation).toMatchObject({ id: old.id, inviterDid: MOD, status: 'PENDING' });
        expect(Date.parse(body.invitation.expiresAt)).toBeGreaterThan(Date.now() + 6 * DAY);
        expect(Date.parse(body.invitation.createdAt)).toBeGreaterThan(Date.now() - 60_000);

        const rows = await invitationRows(ring.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'PENDING', inviterDid: MOD, respondedAt: null });
        expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it.each(['ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'] as const)(
        're-invites over a %s invitation for someone who is not a member (was a 500 on the unique key)',
        async (oldStatus) => {
            const slug = `invite-after-${oldStatus.toLowerCase()}`;
            const ring = await makeRing(slug);
            await prisma.invitation.create({
                data: {
                    ringId: ring.id,
                    inviteeDid: GUEST,
                    inviterDid: OWNER,
                    status: oldStatus,
                    // An accepted invite usually still has time left on it.
                    expiresAt: new Date(Date.now() + 2 * DAY),
                    respondedAt: new Date(Date.now() - DAY),
                },
            });

            const { status, body } = await invite(slug, { inviteeDid: GUEST }, OWNER);

            expect(status).toBe(200);
            expect(body.invitation).toMatchObject({ inviteeDid: GUEST, status: 'PENDING' });
            const rows = await invitationRows(ring.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'PENDING', respondedAt: null });
        }
    );

    it('honours a caller-chosen expiresAt on a reused row', async () => {
        const ring = await makeRing('invite-custom-expiry');
        await prisma.invitation.create({
            data: { ringId: ring.id, inviteeDid: GUEST, inviterDid: OWNER, status: 'ACCEPTED', expiresAt: new Date(Date.now() + DAY) },
        });
        const wanted = new Date(Date.now() + 30 * DAY).toISOString();

        const { status, body } = await invite('invite-custom-expiry', { inviteeDid: GUEST, expiresAt: wanted }, OWNER);

        expect(status).toBe(200);
        expect(body.invitation.expiresAt).toBe(wanted);
    });

    it('still refuses to invite an active member, even with an accepted invitation on file', async () => {
        const ring = await makeRing('invite-member');
        await prisma.invitation.create({
            data: { ringId: ring.id, inviteeDid: MEMBER, inviterDid: OWNER, status: 'ACCEPTED', expiresAt: new Date(Date.now() + DAY) },
        });

        const { status, body } = await invite('invite-member', { inviteeDid: MEMBER }, OWNER);

        expect(status).toBe(400);
        expect(body.error).toBe('Already a member');
        const row = await prisma.invitation.findFirst({ where: { ringId: ring.id, inviteeDid: MEMBER } });
        expect(row!.status).toBe('ACCEPTED');
    });

    it('only owners and moderators can invite', async () => {
        const ring = await makeRing('invite-forbidden');

        const { status } = await invite('invite-forbidden', { inviteeDid: GUEST }, MEMBER);

        expect(status).toBe(403);
        expect(await invitationRows(ring.id)).toHaveLength(0);
    });
});
