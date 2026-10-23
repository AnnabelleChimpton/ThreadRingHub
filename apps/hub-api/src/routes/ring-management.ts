import { FastifyInstance } from 'fastify';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import {
    authenticateActor,
    requireVerifiedActor,
    requireNotBlocked,
} from '../security/middleware';
import { isActorBlocked } from '../security/actor-manager';

/** Thrown inside the ownership transaction when the ring changed under us. */
class TransferConflict extends Error {}

/**
 * Ring Management Routes
 * Handles invitations, ownership transfer, and member removal
 */
export async function ringManagementRoutes(fastify: FastifyInstance) {
    /**
     * POST /trp/rings/:slug/transfer-ownership - Hand the ring to another member
     *
     * A ring has one owner: Ring.ownerDid, mirrored by that member's `owner`
     * role. This moves both at once. Allowed for the current owner, or a hub
     * admin (an owner whose account is gone can't sign). The new owner must be
     * an ACTIVE, unblocked member; the previous owner stays on as a member.
     */
    fastify.post<{
        Params: { slug: string };
        Body: { newOwnerDid: string; reason?: string };
    }>('/rings/:slug/transfer-ownership', {
        preHandler: [authenticateActor, requireVerifiedActor],
        schema: {
            params: {
                type: 'object',
                properties: { slug: { type: 'string' } },
                required: ['slug'],
            },
            body: {
                type: 'object',
                properties: {
                    newOwnerDid: { type: 'string', minLength: 1 },
                    reason: { type: 'string', maxLength: 500 },
                },
                required: ['newOwnerDid'],
            },
            tags: ['membership'],
            summary: 'Transfer ring ownership',
            security: [{ httpSignature: [] }],
        },
    }, async (request, reply) => {
        const { slug } = request.params;
        const { newOwnerDid, reason } = request.body;
        const callerDid = request.actor!.did;

        try {
            const ring = await prisma.ring.findUnique({
                where: { slug },
                select: { id: true, slug: true, ownerDid: true, roles: { select: { id: true, name: true } } },
            });
            if (!ring) {
                return reply.code(404).send({ error: 'Not found', message: 'Ring not found' });
            }

            const previousOwnerDid = ring.ownerDid;
            const byAdmin = callerDid !== previousOwnerDid;
            if (byAdmin && !request.actor!.isAdmin) {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Only the ring owner or a hub admin can transfer ownership',
                });
            }

            if (newOwnerDid === previousOwnerDid) {
                return reply.code(400).send({ error: 'Already owner', message: 'That member already owns this ring' });
            }

            const newOwnerMembership = await prisma.membership.findFirst({
                where: { ringId: ring.id, actorDid: newOwnerDid, status: 'ACTIVE' },
                select: { id: true },
            });
            if (!newOwnerMembership) {
                return reply.code(400).send({
                    error: 'Not a member',
                    message: 'The new owner must be an active member of the ring',
                });
            }
            if (await isActorBlocked(newOwnerDid, ring.id)) {
                return reply.code(400).send({ error: 'Blocked', message: 'The new owner is blocked from this ring' });
            }

            const ownerRole = ring.roles.find((role) => role.name === 'owner');
            const memberRole = ring.roles.find((role) => role.name === 'member');
            if (!ownerRole || !memberRole) {
                return reply.code(500).send({
                    error: 'Configuration error',
                    message: 'Ring is missing its owner or member role',
                });
            }

            const transferredAt = new Date();
            await prisma.$transaction(async (tx) => {
                // Only if nobody else moved it first (two transfers racing).
                const moved = await tx.ring.updateMany({
                    where: { id: ring.id, ownerDid: previousOwnerDid },
                    data: { ownerDid: newOwnerDid },
                });
                const promoted = await tx.membership.updateMany({
                    where: { id: newOwnerMembership.id, status: 'ACTIVE' },
                    data: { roleId: ownerRole.id },
                });
                if (moved.count !== 1 || promoted.count !== 1) throw new TransferConflict();

                // The previous owner may have no membership (a ring created for
                // them by a service, or one they already left).
                await tx.membership.updateMany({
                    where: { ringId: ring.id, actorDid: previousOwnerDid, status: { in: ['ACTIVE', 'PENDING'] } },
                    data: { roleId: memberRole.id },
                });

                await tx.auditLog.create({
                    data: {
                        ringId: ring.id,
                        action: 'ring.ownership_transferred',
                        actorDid: callerDid,
                        targetDid: newOwnerDid,
                        metadata: { previousOwnerDid, newOwnerDid, byAdmin, reason: reason || null },
                        timestamp: transferredAt,
                    },
                });
            });

            logger.info({ ringSlug: slug, previousOwnerDid, newOwnerDid, callerDid, byAdmin }, 'Ring ownership transferred');

            return reply.send({
                message: 'Ownership transferred',
                ring: { slug: ring.slug, ownerDid: newOwnerDid },
                previousOwnerDid,
                newOwnerDid,
                byAdmin,
                transferredAt: transferredAt.toISOString(),
            });
        } catch (error) {
            if (error instanceof TransferConflict) {
                return reply.code(409).send({
                    error: 'Conflict',
                    message: 'The ring or the new owner changed while transferring. Try again.',
                });
            }
            logger.error({
                error: error instanceof Error ? error.message : String(error),
                slug,
                newOwnerDid,
            }, 'Failed to transfer ring ownership');

            return reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to transfer ownership',
            });
        }
    });

    /**
     * POST /trp/rings/:slug/invite - Create an invitation to join a ring
     */
    fastify.post<{
        Params: { slug: string };
        Body: { inviteeDid: string; expiresAt?: string };
    }>('/rings/:slug/invite', {
        preHandler: [authenticateActor, requireVerifiedActor, requireNotBlocked()],
    }, async (request, reply) => {
        const { slug } = request.params;
        const { inviteeDid, expiresAt } = request.body;
        const inviterDid = request.actor!.did;

        try {
            // Get ring with memberships
            const ring = await prisma.ring.findUnique({
                where: { slug },
                include: {
                    memberships: {
                        include: { role: true },
                        where: { status: 'ACTIVE' }
                    }
                }
            });

            if (!ring) {
                return reply.code(404).send({ error: 'Ring not found' });
            }

            // Check if inviter is owner or moderator
            const inviterMembership = ring.memberships.find(m => m.actorDid === inviterDid);
            if (!inviterMembership || (inviterMembership.role?.name !== 'owner' && inviterMembership.role?.name !== 'moderator')) {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Only owners and moderators can send invites'
                });
            }

            // Check if invitee is already a member
            const existingMembership = ring.memberships.find(m => m.actorDid === inviteeDid);
            if (existingMembership) {
                return reply.code(400).send({
                    error: 'Already a member',
                    message: 'User is already a member of this ring'
                });
            }

            // One invitation row per (ring, invitee). Only a PENDING one that
            // hasn't run out blocks a new invite; nothing marks rows EXPIRED,
            // so an old expiry counts as gone, same as /trp/join treats it.
            const now = new Date();
            const existingInvite = await prisma.invitation.findUnique({
                where: { ringId_inviteeDid: { ringId: ring.id, inviteeDid } }
            });

            if (existingInvite && existingInvite.status === 'PENDING' && existingInvite.expiresAt > now) {
                return reply.code(400).send({
                    error: 'Invitation exists',
                    message: 'User already has a pending invitation to this ring'
                });
            }

            // Create invitation with expiry (default 7 days)
            const expiryDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

            // An expired, accepted (the person since left), declined or revoked
            // row is reused as a fresh invitation.
            const invitation = await prisma.invitation.upsert({
                where: { ringId_inviteeDid: { ringId: ring.id, inviteeDid } },
                create: {
                    ringId: ring.id,
                    inviteeDid,
                    inviterDid,
                    status: 'PENDING',
                    expiresAt: expiryDate
                },
                update: {
                    inviterDid,
                    status: 'PENDING',
                    expiresAt: expiryDate,
                    createdAt: now,
                    respondedAt: null
                }
            });

            logger.info({
                ringSlug: slug,
                inviterDid,
                inviteeDid,
                invitationId: invitation.id
            }, 'Invitation created');

            return reply.send({
                success: true,
                invitation: {
                    id: invitation.id,
                    ringSlug: slug,
                    inviteeDid: invitation.inviteeDid,
                    inviterDid: invitation.inviterDid,
                    status: invitation.status,
                    createdAt: invitation.createdAt.toISOString(),
                    expiresAt: invitation.expiresAt.toISOString()
                }
            });
        } catch (error) {
            logger.error({
                error: error instanceof Error ? error.message : String(error),
                slug,
                inviterDid,
                inviteeDid
            }, 'Failed to create invitation');

            return reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to create invitation'
            });
        }
    });

    /**
     * DELETE /trp/rings/:slug/members/:actorDid - Remove member from ring
     * Note: PUT /rings/:slug/members/:did for role updates is handled in membership.ts
     */
    fastify.delete<{
        Params: { slug: string; actorDid: string };
    }>('/rings/:slug/members/:actorDid', {
        preHandler: [authenticateActor, requireVerifiedActor],
    }, async (request, reply) => {
        const { slug, actorDid } = request.params;
        const requestorDid = request.actor!.did;

        try {
            // Get ring with memberships
            const ring = await prisma.ring.findUnique({
                where: { slug },
                include: {
                    memberships: {
                        include: { role: true },
                        where: { status: 'ACTIVE' }
                    }
                }
            });

            if (!ring) {
                return reply.code(404).send({ error: 'Ring not found' });
            }

            // The owner removes anyone but themselves; a moderator removes
            // plain members only. Role names, like /invite: moderator
            // deliberately lacks manage_members (see default-roles.ts).
            const requestorRole = ring.memberships.find(m => m.actorDid === requestorDid)?.role?.name;
            const byOwner = requestorDid === ring.ownerDid || requestorRole === 'owner';
            if (!byOwner && requestorRole !== 'moderator') {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Only the ring owner or a moderator can remove members'
                });
            }

            // Find target member
            const targetMembership = ring.memberships.find(m => m.actorDid === actorDid);
            if (!targetMembership) {
                return reply.code(404).send({
                    error: 'Member not found',
                    message: 'User is not a member of this ring'
                });
            }

            // Prevent removing owner
            const targetRole = targetMembership.role?.name;
            if (actorDid === ring.ownerDid || targetRole === 'owner') {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Cannot remove ring owner'
                });
            }
            if (!byOwner && targetRole === 'moderator') {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Only the ring owner can remove a moderator'
                });
            }

            // REVOKED like a leave, but removedBy keeps them from rejoining an
            // open ring on their own (/trp/join asks for an invitation).
            const removedAt = new Date();
            await prisma.$transaction([
                prisma.membership.update({
                    where: { id: targetMembership.id },
                    data: { status: 'REVOKED', leftAt: removedAt, removedBy: requestorDid }
                }),
                prisma.badge.updateMany({
                    where: { membershipId: targetMembership.id, revokedAt: null },
                    data: { revokedAt: removedAt, revocationReason: 'Removed from ring' }
                }),
                prisma.auditLog.create({
                    data: {
                        ringId: ring.id,
                        action: 'membership.removed',
                        actorDid: requestorDid,
                        targetDid: actorDid,
                        metadata: { membershipId: targetMembership.id, role: targetRole, byRole: byOwner ? 'owner' : 'moderator' },
                        timestamp: removedAt
                    }
                }),
            ]);

            logger.info({
                ringSlug: slug,
                requestorDid,
                removedDid: actorDid
            }, 'Member removed from ring');

            return reply.send({
                success: true,
                message: 'Member removed from ring'
            });
        } catch (error) {
            logger.error({
                error: error instanceof Error ? error.message : String(error),
                slug,
                actorDid
            }, 'Failed to remove member');

            return reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to remove member'
            });
        }
    });
}
