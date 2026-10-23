/**
 * GET /trp/rings/:slug for a PRIVATE ring, against real Postgres: only its
 * ACTIVE members see it, by their signature (the route runs no
 * authenticateActor, so it checks the signature itself, for private rings
 * only). Signatures are stubbed: `x-test-actor` stands in for a valid
 * signer (ThreadStead's federation suite covers real signatures).
 */
import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/database/prisma';

const verifyHttpSignature = jest.fn(async (request: any) => {
    const did = request.headers['x-test-actor'];
    return did ? { valid: true, actorDid: did } : { valid: false, error: 'Missing signature header' };
});
jest.mock('../src/security/http-signature', () => ({
    ...jest.requireActual('../src/security/http-signature'),
    verifyHttpSignature: (request: any) => verifyHttpSignature(request),
}));

// eslint-disable-next-line import/first
import { ringsRoutes } from '../src/routes/rings';

const OWNER = 'did:web:owner.private.test';
const ALICE = 'did:web:alice.private.test';
const PENDING_PAT = 'did:web:pat.private.test';
const STRANGER = 'did:web:stranger.private.test';
const PRIVATE = 'private-read';
const PUBLIC = 'public-read';

let app: FastifyInstance;

async function get(slug: string, actor?: string) {
    const res = await app.inject({ method: 'GET', url: `/trp/rings/${slug}`, headers: actor ? { 'x-test-actor': actor } : {} });
    return { status: res.statusCode, body: res.json() as any };
}

beforeAll(async () => {
    app = Fastify();
    await app.register(ringsRoutes, { prefix: '/trp' });
    await app.ready();

    for (const [slug, visibility] of [[PRIVATE, 'PRIVATE'], [PUBLIC, 'PUBLIC']] as const) {
        const ring = await prisma.ring.create({ data: { slug, name: slug, ownerDid: OWNER, visibility } });
        await prisma.membership.createMany({
            data: [
                { ringId: ring.id, actorDid: OWNER, status: 'ACTIVE', joinedAt: new Date() },
                { ringId: ring.id, actorDid: ALICE, status: 'ACTIVE', joinedAt: new Date() },
                { ringId: ring.id, actorDid: PENDING_PAT, status: 'PENDING' },
            ],
        });
    }
});

afterAll(async () => {
    await prisma.ring.deleteMany({ where: { slug: { in: [PRIVATE, PUBLIC] } } });
    await app.close();
    await prisma.$disconnect();
});

beforeEach(() => verifyHttpSignature.mockClear());

describe('GET /trp/rings/:slug', () => {
    it('shows a private ring to its ACTIVE members, with their own membership and the member count', async () => {
        for (const member of [OWNER, ALICE]) {
            const { status, body } = await get(PRIVATE, member);
            expect(status).toBe(200);
            expect(body).toMatchObject({ slug: PRIVATE, visibility: 'PRIVATE', ownerDid: OWNER, memberCount: 2 });
            expect(body.currentUserMembership).toMatchObject({ status: 'ACTIVE' });
        }
    });

    it('is 404 to anyone else: unsigned, a stranger, or someone still waiting', async () => {
        for (const actor of [undefined, STRANGER, PENDING_PAT]) {
            const { status, body } = await get(PRIVATE, actor);
            expect(status).toBe(404);
            expect(body.message).toBe('Ring not found');
        }
    });

    it('is 404 when the signature does not verify, even for a member', async () => {
        verifyHttpSignature.mockResolvedValueOnce({ valid: false, actorDid: ALICE, error: 'Invalid signature' } as any);
        expect((await get(PRIVATE, ALICE)).status).toBe(404);
    });

    it("reads a public ring without looking at the signature, as before", async () => {
        const { status, body } = await get(PUBLIC, STRANGER);
        expect(status).toBe(200);
        expect(body.memberCount).toBe(2);
        expect(body.currentUserMembership).toBeUndefined();
        expect(verifyHttpSignature).not.toHaveBeenCalled();
    });
});
