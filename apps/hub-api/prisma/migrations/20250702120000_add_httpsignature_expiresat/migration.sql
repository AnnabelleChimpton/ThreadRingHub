-- AlterTable
-- Add cache-expiry so rotated client keys can be re-resolved from the DID doc
-- instead of being served from the DB cache forever.
ALTER TABLE "HttpSignature" ADD COLUMN "expiresAt" TIMESTAMP(3);
