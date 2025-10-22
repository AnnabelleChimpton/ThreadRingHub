
-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "instanceDomain" TEXT,
ADD COLUMN     "profileLastFetched" TIMESTAMP(3),
ADD COLUMN     "profileSource" TEXT,
ADD COLUMN     "profileUrl" TEXT,
ALTER COLUMN "joinedAt" DROP NOT NULL,
ALTER COLUMN "joinedAt" DROP DEFAULT;