import { FastifyInstance } from 'fastify';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import {
    authenticateActor,
    requireVerifiedActor,
    requireNotBlocked,
} from '../security/middleware';

/**
 * Ring Management Routes
 * Handles invitations, member role updates, and member removal
 */
export async function ringManagementRoutes(fastify: FastifyInstance) {
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

            // Check for existing pending invitation
            const existingInvite = await prisma.invitation.findFirst({
                where: {
                    ringId: ring.id,
                    inviteeDid,
                    status: 'PENDING'
                }
            });

            if (existingInvite) {
                return reply.code(400).send({
                    error: 'Invitation exists',
                    message: 'User already has a pending invitation to this ring'
                });
            }

            // Create invitation with expiry (default 7 days)
            const expiryDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

            const invitation = await prisma.invitation.create({
                data: {
                    ringId: ring.id,
                    inviteeDid,
                    inviterDid,
                    status: 'PENDING',
                    expiresAt: expiryDate
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

            // Check if requestor is owner
            const requestorMembership = ring.memberships.find(m => m.actorDid === requestorDid);
            if (!requestorMembership || requestorMembership.role?.name !== 'owner') {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Only ring owner can remove members'
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
            if (targetMembership.role?.name === 'owner') {
                return reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Cannot remove ring owner'
                });
            }

            // Update membership status to REVOKED instead of deleting
            await prisma.membership.update({
                where: { id: targetMembership.id },
                data: {
                    status: 'REVOKED',
                    leftAt: new Date()
                }
            });

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
