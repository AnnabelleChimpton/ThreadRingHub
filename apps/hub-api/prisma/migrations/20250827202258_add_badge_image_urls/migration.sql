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
-- Note: This assumes Badge table structure was manually updated to current schema format
-- If not already done, the following would be needed:
-- 1. Drop old Badge table and recreate with new structure
-- 2. Update foreign key constraints
-- 3. Migrate any existing badge data

-- The Badge model should have:
-- - id (primary key)
-- - membershipId (foreign key to Membership.id, unique)
-- - badgeData (JSONB)
-- - issuedAt (timestamp)
-- - revokedAt (nullable timestamp)  
-- - revocationReason (nullable text)

-- Add foreign key constraint for Badge.membershipId if not exists
-- This will fail if the constraint already exists, which is expected
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'Badge_membershipId_fkey'
    ) THEN
        ALTER TABLE "Badge" ADD CONSTRAINT "Badge_membershipId_fkey" 
        FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;