/**
 * POST /trp/submit: who a PostRef is attributed to, against real Postgres.
 * The author comes from the signature; only a hub admin (an instance posting
 * for one of its users) may name someone else in `actorDid`. HTTP signatures
 * are stubbed as in ownership-transfer.test.ts: `x-test-actor` stands in for
 * a verified signer and `x-test-admin: 1` makes it a hub admin
 * (ThreadStead's federation suite covers real signatures).
 */
import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/database/prisma';

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
import { contentRoutes } from '../src/routes/content';

const SLUG = 'submit-author-test';
const MEMBER = 'did:web:member.submit.test';
const OTHER = 'did:web:other.submit.test';
const ADMIN = 'did:web:admin.submit.test';

let app: FastifyInstance;
let ringId: string;

async function submit(body: Record<string, unknown>, actor: string, admin = false) {
    const headers: Record<string, string> = { 'x-test-actor': actor };
    if (admin) headers['x-test-admin'] = '1';
    const res = await app.inject({
        method: 'POST',
        url: '/trp/submit',
        payload: { ringSlug: SLUG, digest: 'sha256:submit-test', ...body },
        headers,
    });
    return { status: res.statusCode, body: res.json() as any };
}

const uri = (name: string) => `https://submit.test/posts/${name}`;

beforeAll(async () => {
    app = Fastify();
    await app.register(contentRoutes, { prefix: '/trp' });
    await app.ready();

    // Members-only, so the admin case also shows an admin isn't held to membership.
    const ring = await prisma.ring.create({ data: { slug: SLUG, name: SLUG, ownerDid: MEMBER, postPolicy: 'MEMBERS' } });
    ringId = ring.id;
    await prisma.membership.create({ data: { ringId, actorDid: MEMBER, status: 'ACTIVE', joinedAt: new Date() } });
});

afterAll(async () => {
    // Memberships, PostRefs and audit rows cascade with the ring.
    await prisma.ring.deleteMany({ where: { slug: SLUG } });
    await app.close();
    await prisma.$disconnect();
});

describe('POST /trp/submit author', () => {
    it('refuses a member naming someone else as the author, and stores nothing', async () => {
        const { status, body } = await submit({ uri: uri('spoof'), actorDid: OTHER }, MEMBER);

        expect(status).toBe(403);
        expect(body).toEqual({ error: 'Forbidden', message: 'actorDid must match the signing actor' });
        expect(await prisma.postRef.count({ where: { ringId, uri: uri('spoof') } })).toBe(0);
    });

    it('accepts a member naming themselves', async () => {
        const { status, body } = await submit({ uri: uri('self'), actorDid: MEMBER }, MEMBER);

        expect(status).toBe(201);
        expect(body.post).toMatchObject({ actorDid: MEMBER, submittedBy: MEMBER, status: 'ACCEPTED' });
    });

    it('makes the signer the author when actorDid is left out', async () => {
        const { status, body } = await submit({ uri: uri('omitted') }, MEMBER);

        expect(status).toBe(201);
        expect(body.post).toMatchObject({ actorDid: MEMBER, submittedBy: MEMBER });
    });

    it('lets a hub admin post on behalf of someone else, recording both', async () => {
        const { status, body } = await submit({ uri: uri('on-behalf'), actorDid: OTHER }, ADMIN, true);

        expect(status).toBe(201);
        expect(body.post).toMatchObject({ actorDid: OTHER, submittedBy: ADMIN });

        const audit = await prisma.auditLog.findFirst({
            where: { ringId, action: 'content.submitted', metadata: { path: ['postId'], equals: body.post.id } },
        });
        expect(audit).toMatchObject({ actorDid: ADMIN, targetDid: OTHER });
    });
});
