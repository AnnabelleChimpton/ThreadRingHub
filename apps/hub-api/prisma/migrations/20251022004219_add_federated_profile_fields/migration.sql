
-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "instanceDomain" TEXT,
ADD COLUMN     "profileLastFetched" TIMESTAMP(3),
ADD COLUMN     "profileSource" TEXT,
ADD COLUMN     "profileUrl" TEXT,
ALTER COLUMN "joinedAt" DROP NOT NULL,
ALTER COLUMN "joinedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Invitation" (
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
CREATE INDEX "Invitation_ringId_idx" ON "Invitation"("ringId");

-- CreateIndex
CREATE INDEX "Invitation_inviteeDid_idx" ON "Invitation"("inviteeDid");

-- CreateIndex
CREATE INDEX "Invitation_status_idx" ON "Invitation"("status");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_ringId_inviteeDid_key" ON "Invitation"("ringId", "inviteeDid");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;
