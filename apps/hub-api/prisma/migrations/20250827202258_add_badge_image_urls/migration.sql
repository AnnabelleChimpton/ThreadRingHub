-- Add badge image URL fields to Ring table
-- These fields allow rings to have 88x31 badge images and optional high-res variants
-- Also update Badge model structure and add missing Membership fields

-- AlterTable Ring: Add badge image fields
ALTER TABLE "Ring" ADD COLUMN IF NOT EXISTS "badgeImageUrl" TEXT;
ALTER TABLE "Ring" ADD COLUMN IF NOT EXISTS "badgeImageHighResUrl" TEXT;

-- AlterTable Membership: Add missing fields for application/leave tracking
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "applicationMessage" TEXT;
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "leaveReason" TEXT;
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "leftAt" TIMESTAMP(3);

-- Update Badge table structure to match current schema
-- Migrate from old structure (ringId, issuedTo) to new structure (membershipId)

-- Drop the old Badge table and recreate with new structure
DROP TABLE IF EXISTS "Badge" CASCADE;

CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "badgeData" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint on membershipId
CREATE UNIQUE INDEX "Badge_membershipId_key" ON "Badge"("membershipId");

-- Create index on membershipId for faster lookups
CREATE INDEX "Badge_membershipId_idx" ON "Badge"("membershipId");

-- Create index on issuedAt for sorting
CREATE INDEX "Badge_issuedAt_idx" ON "Badge"("issuedAt");

-- Add foreign key constraint for Badge.membershipId
ALTER TABLE "Badge" ADD CONSTRAINT "Badge_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;