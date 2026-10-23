-- Membership.removedBy: who removed this member (an owner or moderator), so
-- /trp/join can tell a removal from a voluntary leave. Both end as REVOKED;
-- a removed member needs an invitation to come back. Hand-written.

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "removedBy" TEXT;
