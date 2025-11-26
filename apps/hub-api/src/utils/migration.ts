import { prisma } from '../database/prisma';
import { logger } from './logger';
import { config } from '../config';
import crypto from 'crypto';
import { generateBadge } from './badge';

/**
 * Re-sign all existing badges with the current private key.
 * This ensures that badges generated with previous ephemeral keys (or a different persistent key)
 * are updated to be valid with the current key.
 */
export async function resignBadges() {
    logger.info('Starting badge re-signing migration...');

    if (!config.security.privateKey) {
        logger.warn('No persistent private key configured. Skipping badge re-signing as keys are ephemeral.');
        return;
    }

    let privateKey: crypto.KeyObject;
    try {
        const privateKeyBuffer = Buffer.from(config.security.privateKey, 'base64');
        privateKey = crypto.createPrivateKey(privateKeyBuffer);
    } catch (error) {
        logger.error({ error }, 'Failed to load private key for re-signing. Aborting migration.');
        return;
    }

    const BATCH_SIZE = 50;
    let processedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;

    try {
        // Process badges in batches
        let cursor: string | undefined;

        while (true) {
            const badges = await prisma.badge.findMany({
                take: BATCH_SIZE,
                skip: cursor ? 1 : 0,
                ...(cursor ? { cursor: { id: cursor } } : {}),
                orderBy: { id: 'asc' },
                include: {
                    membership: {
                        include: {
                            ring: true,
                            role: true,
                        }
                    }
                }
            });

            if (badges.length === 0) break;

            for (const badgeRecord of badges) {
                processedCount++;
                try {
                    const badgeWithRel = badgeRecord as any;
                    const actorDid = badgeWithRel.membership.actorDid;

                    // Generate new badge with persistent key
                    const newBadge = await generateBadge(
                        badgeWithRel.membership.ring.slug,
                        badgeWithRel.membership.ring.name,
                        actorDid,
                        badgeWithRel.membership.role.name,
                        privateKey,
                        config.hubUrl,
                        // We don't have easy access to original image URLs here without parsing old badge data
                        // For now, let's assume they are standard or undefined.
                        // If we really need them, we can parse `badgeRecord.badgeData`.
                        undefined,
                        undefined
                    );

                    // Update the database record
                    // We update the `badgeData` JSON. 
                    // We also update the `id` of the record to match the new badge ID.

                    await prisma.$transaction(async (tx) => {
                        // 1. Create new badge record
                        await tx.badge.create({
                            data: {
                                id: newBadge.id.split('/').pop()!, // Extract ID from URL
                                membershipId: badgeRecord.membershipId,
                                badgeData: newBadge as any,
                                issuedAt: new Date(newBadge.issuanceDate),
                            }
                        });

                        // 2. Update Membership to point to new badge
                        await tx.membership.update({
                            where: { id: badgeRecord.membershipId },
                            data: { badgeId: newBadge.id.split('/').pop()! }
                        });

                        // 3. Delete old badge
                        await tx.badge.delete({
                            where: { id: badgeRecord.id }
                        });
                    });

                    updatedCount++;
                } catch (err) {
                    logger.error({ error: err, badgeId: badgeRecord.id }, 'Failed to re-sign badge');
                    errorCount++;
                }
            }

            cursor = badges[badges.length - 1]!.id;
        }

        logger.info({ processedCount, updatedCount, errorCount }, 'Badge re-signing migration completed');
    } catch (error) {
        logger.error({ error }, 'Fatal error during badge re-signing migration');
    }
}
