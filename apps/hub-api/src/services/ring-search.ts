/**
 * Ring listing and search for GET /trp/rings.
 *
 * Search (migrations/20261018000000_add_ring_search_fts):
 * - websearch_to_tsquery over search_tsv (name A, shortCode A, description B,
 *   english config): quotes are phrases, `-word` excludes, `or` works,
 *   malformed input never errors, plurals and verb forms match.
 * - Word prefixes ("knit" → "Knitters", "pott" → "pottery") also go
 *   through the tsvector, so a partial word in a name outranks a whole word
 *   in a description. Words of 3+ characters only, never for quoted queries.
 * - word_similarity (`<%`, trigram GIN on name) catches typos ("knittng").
 * - An escaped substring match on name and short code keeps every match the
 *   old ILIKE search found there ("ook" → "Book Club"); 1–2 characters only
 *   match the start of a word. `%` and `_` are literal.
 *
 * Every value from the request is a bound parameter (Prisma.sql), never
 * concatenated into the SQL. This only selects ids; the route hydrates them.
 */
import { Prisma, RingVisibility } from '@prisma/client';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';

export type RingListSort = 'created' | 'updated' | 'name' | 'members' | 'relevance';

/** Raw signals for one matched ring, on ThreadStead's search scale. */
export interface RingRelevance {
    /** ts_rank_cd: a name hit counts 1.0, a description hit 0.4. */
    textRank: number;
    /** pg_trgm word_similarity of the query against name, short code or slug, 0..1. */
    trigram: number;
}

export interface RingListQuery {
    search?: string | undefined;
    /** Restrict to one visibility (the route decides what the viewer may see). */
    visibility?: RingVisibility | undefined;
    /** Only rings this DID is an ACTIVE member of. */
    memberDid?: string | undefined;
    sort: RingListSort;
    order: 'asc' | 'desc';
    limit: number;
    offset: number;
}

export interface RingListPage {
    ids: string[];
    total: number;
    /** Present for each returned ring when the query had search words (and the migration has run). */
    relevance: Map<string, RingRelevance>;
}

/** Longer searches are cut to this many characters. */
export const MAX_SEARCH_LENGTH = 200;

/** Escape LIKE/ILIKE wildcards (Postgres' default escape is backslash). */
export function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * websearch_to_tsquery understands quotes and `-word`; trigram and substring
 * matching don't. So they only see the positive words, a quoted query skips
 * trigram matching (a phrase means "exactly this"), and the `-words` apply to
 * every row however it matched. Same split as ThreadStead's lib/search/local.ts.
 */
export function splitSearch(raw: string): {
    query: string;
    fuzzy: string;
    similarTo: string;
    excluded: string;
} {
    const query = raw.trim().slice(0, MAX_SEARCH_LENGTH);
    const tokens = query.split(/\s+/).filter(Boolean);
    const positive = tokens.filter((t) => !t.startsWith('-') && t.toLowerCase() !== 'or').join(' ');
    const excluded = tokens
        .filter((t) => t.length > 1 && t.startsWith('-'))
        .map((t) => t.slice(1))
        .join(' or ');
    const similarTo = positive.replace(/"/g, '').trim();
    return { query, fuzzy: query.includes('"') ? '' : similarTo, similarTo, excluded };
}

/**
 * to_tsquery text matching every positive word as a prefix ("knit:* & guild:*"),
 * or '' for none. Words are reduced to letters and digits first, so no
 * tsquery syntax from the request survives.
 */
export function prefixQuery(fuzzy: string): string {
    return fuzzy
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .map((w) => (w.length >= 3 ? `${w}:*` : w))
        .join(' & ');
}

/** Text + trigram on ThreadStead's blend scale (lib/search/relevance.ts). */
const SCORE = Prisma.sql`(0.55 * text_rank / (text_rank + 0.3) + 0.15 * trigram)`;

const MEMBER_COUNT = Prisma.sql`(SELECT count(*) FROM "Membership" m WHERE m."ringId" = c.id AND m.status = 'ACTIVE')`;

function orderBy(sort: RingListSort, order: 'asc' | 'desc', scored: boolean): Prisma.Sql {
    const dir = Prisma.raw(order === 'asc' ? 'ASC' : 'DESC');
    switch (sort) {
        case 'name':
            return Prisma.sql`c.name ${dir}, c.id ${dir}`;
        case 'updated':
            return Prisma.sql`c."updatedAt" ${dir}, c.id ${dir}`;
        case 'members':
            return Prisma.sql`${MEMBER_COUNT} ${dir}, c."createdAt" DESC, c.id`;
        case 'relevance':
            // Best first whatever `order` says; without scores it's "biggest first".
            return scored
                ? Prisma.sql`c.exact DESC, ${SCORE} DESC, ${MEMBER_COUNT} DESC, c."createdAt" DESC, c.id`
                : Prisma.sql`${MEMBER_COUNT} DESC, c."createdAt" DESC, c.id`;
        case 'created':
        default:
            return Prisma.sql`c."createdAt" ${dir}, c.id ${dir}`;
    }
}

interface SearchSql {
    input: Prisma.Sql;
    signals: Prisma.Sql;
    filters: Prisma.Sql[];
    /** Rows carry real text/trigram signals. */
    scored: boolean;
}

const NO_SEARCH: SearchSql = {
    input: Prisma.sql`SELECT 1`,
    signals: Prisma.sql`0::float8 AS text_rank, 0::float8 AS trigram, false AS exact`,
    filters: [],
    scored: false,
};

function fullTextSearch(search: string): SearchSql {
    const { query, fuzzy, similarTo, excluded } = splitSearch(search);
    const prefix = prefixQuery(fuzzy);
    // 1–2 characters: start of a word (in the name) or of the short code.
    // Longer: anywhere in either.
    const escaped = escapeLike(similarTo);
    const short = similarTo.length < 3;
    const substring = !similarTo
        ? Prisma.sql`false`
        : short
          ? Prisma.sql`(r.name ILIKE ${`${escaped}%`} OR r.name ILIKE ${`% ${escaped}%`} OR COALESCE(r."shortCode" ILIKE ${`${escaped}%`}, false))`
          : Prisma.sql`(r.name ILIKE ${`%${escaped}%`} OR COALESCE(r."shortCode" ILIKE ${`%${escaped}%`}, false))`;

    const filters = [
        Prisma.sql`(
            COALESCE(r.search_tsv @@ input.tsq, false)
            OR COALESCE(r.search_tsv @@ input.ptsq, false)
            OR (input.fuzzy <> '' AND input.fuzzy <% r.name)
            OR ${substring}
        )`,
    ];
    if (excluded) {
        filters.push(Prisma.sql`NOT COALESCE(r.search_tsv @@ websearch_to_tsquery('english', public.immutable_unaccent(${excluded})), false)`);
    }
    return {
        input: Prisma.sql`
            SELECT websearch_to_tsquery('english', public.immutable_unaccent(${query})) AS tsq,
                   to_tsquery('english', public.immutable_unaccent(${prefix})) AS ptsq,
                   lower(public.immutable_unaccent(${fuzzy})) AS fuzzy,
                   lower(public.immutable_unaccent(${similarTo})) AS sim`,
        signals: Prisma.sql`
            GREATEST(
              COALESCE(ts_rank_cd(r.search_tsv, input.tsq), 0),
              COALESCE(ts_rank_cd(r.search_tsv, input.ptsq), 0)
            )::float8 AS text_rank,
            GREATEST(
              word_similarity(input.sim, r.name),
              COALESCE(word_similarity(input.sim, r."shortCode"), 0),
              word_similarity(input.sim, r.slug)
            )::float8 AS trigram,
            COALESCE(input.sim <> '' AND (
              lower(public.immutable_unaccent(r.name)) = input.sim
              OR lower(r."shortCode") = input.sim
              OR lower(r.slug) = input.sim
            ), false) AS exact`,
        filters,
        scored: true,
    };
}

/**
 * The pre-2026-10-18 search (substring of name, description or short code),
 * with wildcards escaped. Only used while the database lacks the search
 * migration: deploy.sh pulls the code (which the dev-mode container
 * hot-reloads) minutes before it runs `prisma migrate deploy`.
 */
function substringSearch(search: string): SearchSql {
    const pattern = `%${escapeLike(search.trim().slice(0, MAX_SEARCH_LENGTH))}%`;
    return {
        ...NO_SEARCH,
        filters: [
            Prisma.sql`(r.name ILIKE ${pattern} OR COALESCE(r.description ILIKE ${pattern}, false) OR COALESCE(r."shortCode" ILIKE ${pattern}, false))`,
        ],
    };
}

/** Postgres "undefined column / function / object": the search migration hasn't run. */
function isMissingSearchSchema(error: unknown): boolean {
    const code = (error as { meta?: { code?: string } })?.meta?.code;
    return code === '42703' || code === '42883' || code === '42704';
}

export async function selectRingPage(q: RingListQuery): Promise<RingListPage> {
    const searching = splitSearch(q.search ?? '').query.length > 0;
    if (!searching) return runPage(q, NO_SEARCH);
    try {
        return await runPage(q, fullTextSearch(q.search ?? ''));
    } catch (error) {
        if (!isMissingSearchSchema(error)) throw error;
        logger.warn({ error }, 'Ring search migration not applied yet; using substring search');
        return runPage(q, substringSearch(q.search ?? ''));
    }
}

async function runPage(q: RingListQuery, search: SearchSql): Promise<RingListPage> {
    const filters: Prisma.Sql[] = [...search.filters];
    if (q.visibility) filters.push(Prisma.sql`r.visibility = ${q.visibility}::"RingVisibility"`);
    if (q.memberDid) {
        filters.push(Prisma.sql`EXISTS (
            SELECT 1 FROM "Membership" mm
            WHERE mm."ringId" = r.id AND mm."actorDid" = ${q.memberDid} AND mm.status = 'ACTIVE'
        )`);
    }

    const where = filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}` : Prisma.empty;
    const candidates = Prisma.sql`
        WITH input AS (${search.input}),
        candidates AS (
            SELECT r.id, r.name, r."createdAt", r."updatedAt", ${search.signals}
            FROM "Ring" r CROSS JOIN input
            ${where}
        )`;

    const [rows, counted] = await Promise.all([
        prisma.$queryRaw<Array<{ id: string; text_rank: number; trigram: number }>>`
            ${candidates}
            SELECT c.id, c.text_rank, c.trigram FROM candidates c
            ORDER BY ${orderBy(q.sort, q.order, search.scored)}
            LIMIT ${q.limit} OFFSET ${q.offset}`,
        prisma.$queryRaw<Array<{ total: bigint }>>`${candidates} SELECT count(*) AS total FROM candidates`,
    ]);

    const relevance = new Map<string, RingRelevance>();
    if (search.scored) {
        for (const row of rows) {
            relevance.set(row.id, { textRank: Number(row.text_rank) || 0, trigram: Number(row.trigram) || 0 });
        }
    }
    return { ids: rows.map((r) => r.id), total: Number(counted[0]?.total ?? 0), relevance };
}
