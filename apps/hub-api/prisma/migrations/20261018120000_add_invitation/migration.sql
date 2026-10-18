-- Invitation: in schema.prisma since early on, but never given a migration.
-- Production got the table some other way (probably `prisma db push`), so a
-- hub built from `prisma migrate deploy` alone was missing it. Hand-written.
--
-- Matches production's DDL exactly (pg_dump of "Invitation" and the
-- "InvitationStatus" enum, 2026-10-18): same columns, defaults, constraint and
-- index names.
--
-- Safe to re-run and a no-op on production: the enum is created only if it is
-- missing, the table and indexes are IF NOT EXISTS, and the foreign key is
-- added only if the table doesn't already have it.

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Invitation" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "inviteeDid" TEXT NOT NULL,
    "inviterDid" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invitation_ringId_idx" ON "Invitation"("ringId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invitation_inviteeDid_idx" ON "Invitation"("inviteeDid");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invitation_status_idx" ON "Invitation"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Invitation_ringId_inviteeDid_key" ON "Invitation"("ringId", "inviteeDid");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'Invitation_ringId_fkey'
          AND conrelid = '"Invitation"'::regclass
    ) THEN
        ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
