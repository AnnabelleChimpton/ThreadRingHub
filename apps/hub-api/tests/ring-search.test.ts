/**
 * GET /trp/rings: search, sort and visibility, against real Postgres with the
 * real ring-search migration. HTTP signatures are stubbed: an `x-test-actor`
 * header stands in for a verified signer (ThreadStead's federation suite
 * covers real signatures).
 */
import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../src/database/prisma';

jest.mock('../src/security/middleware', () => {
    const actual = jest.requireActual('../src/security/middleware');
    return {
        ...actual,
        authenticateActor: async (request: any) => {
            const did = request.headers['x-test-actor'];
            if (did) request.actor = { did, verified: true, trusted: false, isAdmin: false };
        },
    };
});

// eslint-disable-next-line import/first
import { ringsRoutes } from '../src/routes/rings';

const OWNER = 'did:web:owner.test';
const ALICE = 'did:web:alice.test';

let app: FastifyInstance;

async function list(query: Record<string, string>, actor?: string) {
    const res = await app.inject({
        method: 'GET',
        url: '/trp/rings',
        query,
        headers: actor ? { 'x-test-actor': actor } : {},
    });
    return { status: res.statusCode, body: res.json() as any };
}

async function slugs(query: Record<string, string>, actor?: string): Promise<string[]> {
    const { status, body } = await list(query, actor);
    expect(status).toBe(200);
    return body.rings.map((r: any) => r.slug);
}

async function ring(slug: string, name: string, extra: Record<string, unknown> = {}, createdAt?: Date) {
    return prisma.ring.create({
        data: { slug, name, ownerDid: OWNER, ...(createdAt ? { createdAt } : {}), ...extra },
    });
}

async function members(ringId: string, count: number, status: 'ACTIVE' | 'PENDING' = 'ACTIVE') {
    for (let i = 0; i < count; i++) {
        await prisma.membership.create({
            data: { ringId, actorDid: `did:web:m${i}-${status}.${ringId}.test`, status },
        });
    }
}

beforeAll(async () => {
    app = Fastify();
    await app.register(ringsRoutes, { prefix: '/trp' });
    await app.ready();

    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    const knitting = await ring('knitting-circle', 'Knitting Circle', { description: 'For knitters and crocheters', shortCode: 'yarn' }, day(1));
    const books = await ring('book-club', 'Book Club', { description: 'Monthly reading, all genres' }, day(2));
    await ring('secret-garden', 'Secret Garden Society', { description: 'Private gardening chat', visibility: 'PRIVATE' }, day(3));
    await ring('garden-shed', 'Unlisted Garden Shed', { description: 'Tools and seeds', visibility: 'UNLISTED' }, day(4));
    await ring('cotton', '100% Cotton', { description: 'Natural fibres' }, day(5));
    await ring('under-score', 'Under_score Fans', {}, day(6));
    await ring('barista', 'Barista Society', { description: 'Coffee people' }, day(7));
    await ring('cafe-creme', 'Café Crème', { description: 'Pastries' }, day(8));
    await ring('night-owls', 'Night Owls', { description: 'We knit after dark' }, day(9));

    await members(books.id, 3);
    await members(knitting.id, 1);
    await members(knitting.id, 4, 'PENDING'); // not counted
    await prisma.membership.create({ data: { ringId: knitting.id, actorDid: ALICE, status: 'ACTIVE' } });
});

afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
});

describe('search matching', () => {
    it('matches several words in any order', async () => {
        expect(await slugs({ search: 'knitting circle' })).toEqual(['knitting-circle']);
        expect(await slugs({ search: 'circle knitting' })).toEqual(['knitting-circle']);
    });

    it('stems words in names and descriptions', async () => {
        // "knitters" is only in Knitting Circle's description.
        expect(await slugs({ search: 'knitter' })).toEqual(['knitting-circle']);
        expect(await slugs({ search: 'genre' })).toEqual(['book-club']);
    });

    it('catches typos in names', async () => {
        expect(await slugs({ search: 'knittng' })).toContain('knitting-circle');
        expect(await slugs({ search: 'barrista' })).toContain('barista');
    });

    it('catches partial words, including mid-word like the old search', async () => {
        expect(await slugs({ search: 'boo' })).toContain('book-club');
        expect(await slugs({ search: 'ook' })).toContain('book-club');
        expect(await slugs({ search: 'kn' })).toContain('knitting-circle'); // word start, 2 chars
        expect(await slugs({ search: 'ni' })).not.toContain('knitting-circle'); // 2 chars mid-word: no
    });

    it('matches the short code', async () => {
        expect(await slugs({ search: 'yarn' })).toEqual(['knitting-circle']);
    });

    it('ignores accents both ways', async () => {
        expect(await slugs({ search: 'cafe creme' })).toEqual(['cafe-creme']);
        expect(await slugs({ search: 'crème' })).toEqual(['cafe-creme']);
    });

    it('treats quotes as a phrase and -word as an exclusion', async () => {
        expect(await slugs({ search: '"book club"' })).toEqual(['book-club']);
        expect(await slugs({ search: '"club book"' })).toEqual([]);
        expect(await slugs({ search: 'knit -dark' })).toEqual(['knitting-circle']);
    });

    it('treats % and _ literally', async () => {
        expect(await slugs({ search: '%' })).toEqual([]); // used to match every ring
        expect(await slugs({ search: '0% cot' })).toEqual(['cotton']);
        // As a wildcard, r_s would also match "Barista" (r-i-s).
        expect(await slugs({ search: 'r_s' })).toEqual(['under-score']);
    });

    it('never errors on hostile input', async () => {
        for (const search of ["'; DROP TABLE \"Ring\"; --", '"', '!!! & | :*', '\\', 'a'.repeat(5000), '-', 'or']) {
            const { status } = await list({ search });
            expect(status).toBe(200);
        }
        expect(await prisma.ring.count()).toBe(9);
    });

    it('treats a blank search as no search', async () => {
        const { body } = await list({ search: '   ' });
        expect(body.total).toBe(7); // every public ring
        expect(body.rings[0].relevance).toBeUndefined();
    });
});

describe('relevance', () => {
    it('attaches relevance signals only when searching', async () => {
        const searched = await list({ search: 'knitting' });
        expect(searched.body.rings[0].relevance).toEqual({
            textRank: expect.any(Number),
            trigram: expect.any(Number),
        });
        expect(searched.body.rings[0].relevance.textRank).toBeGreaterThan(0);

        const listed = await list({});
        expect(listed.body.rings[0].relevance).toBeUndefined();
    });

    it('orders a search best match first by default', async () => {
        // Knitting Circle: the name. Night Owls: only its description.
        expect(await slugs({ search: 'knit' })).toEqual(['knitting-circle', 'night-owls']);
        // An exact name beats a bigger ring.
        expect((await slugs({ search: 'night owls' }))[0]).toBe('night-owls');
    });

    it('ranks a partial word in a name above a whole word in a description', async () => {
        const potters = await ring('potters', 'Potters Guild', {});
        const clay = await ring('clay-folk', 'Clay Folk', { description: 'we pot things', visibility: 'UNLISTED' });
        try {
            expect(await slugs({ search: 'pot' }, ALICE)).toEqual(['potters', 'clay-folk']);
            expect(await slugs({ search: 'pott guil' }, ALICE)).toEqual(['potters']);
            // Prefixes reach descriptions too, but a quoted word is exact.
            expect(await slugs({ search: 'thin' }, ALICE)).toEqual(['clay-folk']);
            expect(await slugs({ search: '"thin"' }, ALICE)).toEqual([]);
        } finally {
            await prisma.ring.deleteMany({ where: { id: { in: [potters.id, clay.id] } } });
        }
    });

    it('accepts sort=relevance explicitly', async () => {
        expect(await slugs({ search: 'knit', sort: 'relevance' })).toEqual(['knitting-circle', 'night-owls']);
    });
});

describe('sorting', () => {
    it('sort=members orders by ACTIVE members', async () => {
        const order = await slugs({ sort: 'members', order: 'desc', limit: '3' });
        // book-club 3, knitting-circle 2 (1 + Alice; 4 pending don't count), then 0s newest first.
        expect(order).toEqual(['book-club', 'knitting-circle', 'night-owls']);
        const asc = await slugs({ sort: 'members', order: 'asc' });
        expect(asc.slice(-2)).toEqual(['knitting-circle', 'book-club']);
    });

    it('keeps an explicit sort for searches (old ThreadStead sends sort=members)', async () => {
        const order = await slugs({ search: 'club OR knitting', sort: 'members', order: 'desc' });
        // Night Owls matches "knit" in its description; 0 members.
        expect(order).toEqual(['book-club', 'knitting-circle', 'night-owls']);
    });

    it('lists newest first by default, and pages', async () => {
        const first = await list({ limit: '2' });
        expect(first.body.rings.map((r: any) => r.slug)).toEqual(['night-owls', 'cafe-creme']);
        expect(first.body).toMatchObject({ total: 7, limit: 2, offset: 0, hasMore: true });
        const last = await list({ limit: '2', offset: '6' });
        expect(last.body.rings.map((r: any) => r.slug)).toEqual(['knitting-circle']);
        expect(last.body.hasMore).toBe(false);
        expect(await slugs({ sort: 'name', order: 'asc', limit: '2' })).toEqual(['cotton', 'barista']);
    });

    it('still rejects unknown sorts', async () => {
        expect((await list({ sort: 'posts' })).status).toBe(400);
    });

    it('reports the search total, not the page size', async () => {
        const { body } = await list({ search: 'knit', limit: '1' });
        expect(body).toMatchObject({ total: 2, hasMore: true });
    });
});

describe('visibility (unchanged rules)', () => {
    it('anonymous viewers only see public rings', async () => {
        expect(await slugs({ search: 'garden' })).toEqual([]);
        expect(await slugs({ search: 'garden', visibility: 'PRIVATE' })).toEqual([]);
    });

    it('signed requests see every visibility, or the one asked for', async () => {
        expect(new Set(await slugs({ search: 'garden' }, ALICE))).toEqual(new Set(['secret-garden', 'garden-shed']));
        expect(await slugs({ search: 'garden', visibility: 'UNLISTED' }, ALICE)).toEqual(['garden-shed']);
        expect(await slugs({ search: 'garden -secret' }, ALICE)).toEqual(['garden-shed']);
    });

    it("someone else's memberships: public rings only", async () => {
        expect(await slugs({ memberDid: ALICE })).toEqual(['knitting-circle']);
        expect(await slugs({ memberDid: ALICE, search: 'knit' }, 'did:web:bob.test')).toEqual(['knitting-circle']);
        expect(await slugs({ memberDid: ALICE, search: 'book' }, ALICE)).toEqual([]);
    });

    it('includes the signer’s membership on each ring', async () => {
        const { body } = await list({ search: 'knitting' }, ALICE);
        expect(body.rings[0].currentUserMembership).toMatchObject({ status: 'ACTIVE' });
        expect(body.rings[0].memberCount).toBe(2);
    });
});

describe('before the migration has run', () => {
    // deploy.sh pulls the code (hot-reloaded by the dev-mode container)
    // minutes before it migrates. Searches must not 500 in that window.
    it('falls back to the old substring search, wildcards escaped, no relevance', async () => {
        await prisma.$executeRawUnsafe('ALTER TABLE "Ring" RENAME COLUMN "search_tsv" TO "search_tsv_hidden"');
        try {
            const { status, body } = await list({ search: 'knit' });
            expect(status).toBe(200);
            expect(new Set(body.rings.map((r: any) => r.slug))).toEqual(new Set(['knitting-circle', 'night-owls']));
            expect(body.rings[0].relevance).toBeUndefined();
            expect(await slugs({ search: '%' })).toEqual(['cotton']);
            expect(await slugs({ search: 'garden' })).toEqual([]); // visibility still applies
        } finally {
            await prisma.$executeRawUnsafe('ALTER TABLE "Ring" RENAME COLUMN "search_tsv_hidden" TO "search_tsv"');
        }
    });
});

describe('search vector upkeep', () => {
    it('follows renames and description edits', async () => {
        const r = await ring('temp-ring', 'Temporary Name', {});
        expect(await slugs({ search: 'temporary' })).toEqual(['temp-ring']);
        await prisma.ring.update({ where: { id: r.id }, data: { name: 'Pottery Wheel', description: 'clay and glaze' } });
        expect(await slugs({ search: 'temporary' })).toEqual([]);
        expect(await slugs({ search: 'glaze' })).toEqual(['temp-ring']);
        await prisma.ring.delete({ where: { id: r.id } });
    });
});
