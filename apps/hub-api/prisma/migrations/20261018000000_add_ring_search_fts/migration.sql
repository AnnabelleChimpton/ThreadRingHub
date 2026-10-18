-- Ring search (ThreadStead SEARCH_PLAN.md Phase 3): Postgres full-text search
-- + trigram matching for GET /trp/rings?search=. Hand-written.
--
-- search_tsv is kept up to date by a trigger, not a GENERATED column: Prisma
-- reports generated columns as drift. schema.prisma declares it as
-- Unsupported("tsvector")? and declares both indexes below, so
-- `prisma migrate diff` against a migrated database shows nothing for Ring.
-- The functions and the trigger are invisible to Prisma.
--
-- Additive only: one nullable column, two indexes, functions, a trigger. Old
-- hub code ignores all of it, so a rollback of the app needs no rollback here.
--
-- Safe to re-run: every statement is IF NOT EXISTS / OR REPLACE, and the
-- backfill only touches rows whose vector is out of date.
--
-- Needs pg_trgm and unaccent (standard contrib, shipped in the postgres
-- Docker images, "trusted" since Postgres 13).
--
-- Config: 'english' for every field. Ring names and descriptions are topic
-- phrases ("Knitting Circle", "for knitters"), where stemming plurals and
-- verb forms matters most, and the query side has to use one config, so the
-- short code uses it too. What english loses (stop words like "The Who",
-- invented names stemmed oddly) the trigram and substring paths on name and
-- short code still catch.

CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;

-- unaccent() is only STABLE (it looks its dictionary up by search_path), so it
-- can't feed an index or a stored column directly. Pinning the dictionary by
-- schema makes it safe to declare IMMUTABLE. Same definition as ThreadStead's.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- name (A) + shortCode (A) + description (B).
CREATE OR REPLACE FUNCTION public.ring_search_tsv(name text, short_code text, description text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('english', public.immutable_unaccent(COALESCE(name, ''))), 'A')
      || setweight(to_tsvector('english', public.immutable_unaccent(COALESCE(short_code, ''))), 'A')
      || setweight(to_tsvector('english', public.immutable_unaccent(left(COALESCE(description, ''), 100000))), 'B')
$$;

ALTER TABLE "Ring" ADD COLUMN IF NOT EXISTS "search_tsv" tsvector;

CREATE OR REPLACE FUNCTION public.ring_search_tsv_update() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW."search_tsv" := public.ring_search_tsv(NEW."name", NEW."shortCode", NEW."description");
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "Ring_search_tsv_trigger" ON "Ring";
CREATE TRIGGER "Ring_search_tsv_trigger"
  BEFORE INSERT OR UPDATE OF "name", "shortCode", "description" ON "Ring"
  FOR EACH ROW EXECUTE FUNCTION public.ring_search_tsv_update();

-- Backfill. Sets the column directly (the trigger only fires on name /
-- shortCode / description), so updatedAt is untouched.
UPDATE "Ring"
SET "search_tsv" = public.ring_search_tsv("name", "shortCode", "description")
WHERE "search_tsv" IS DISTINCT FROM public.ring_search_tsv("name", "shortCode", "description");

CREATE INDEX IF NOT EXISTS "Ring_search_tsv_idx" ON "Ring" USING GIN ("search_tsv");
-- word_similarity (`<%`) and ILIKE on names: typos, partial words, substrings.
CREATE INDEX IF NOT EXISTS "Ring_name_trgm_idx" ON "Ring" USING GIN ("name" gin_trgm_ops);
