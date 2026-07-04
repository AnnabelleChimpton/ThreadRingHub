-- AlterTable
-- Add cache-expiry so rotated client keys can be re-resolved from the DID doc
-- instead of being served from the DB cache forever.
-- IF NOT EXISTS: this migration originally shipped mis-dated as 20250702120000
-- (sorted before init, breaking fresh deploys) and was applied to production
-- under that name. The rename + idempotent SQL lets both fresh databases and
-- production converge on the corrected history; see the deploy note in the
-- commit that renamed it.
ALTER TABLE "HttpSignature" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
