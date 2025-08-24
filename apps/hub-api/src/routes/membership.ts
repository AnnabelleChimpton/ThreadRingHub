import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { 
  authenticateActor, 
  requireVerifiedActor, 
  requireNotBlocked,
  requireMembership,
  requirePermission,
  auditLogger 
} from '../security/middleware';
import {
  JoinRingSchema,
  UpdateMemberRoleSchema,
  type JoinRingInput,
  type UpdateMemberRoleInput,
} from '../schemas/ring-schemas';
import { generateBadge, verifyBadge, revokeBadge, isBadgeRevoked } from '../utils/badge';
import crypto from 'crypto';

// TODO: In production, load this from environment or key management service
const RING_HUB_PRIVATE_KEY = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
}).privateKey;

const RING_HUB_URL = process.env.RING_HUB_URL || 'https://ringhub.example.com';

export async function membershipRoutes(fastify: FastifyInstance) {
  // Add security middleware to all routes
  fastify.addHook('preHandler', auditLogger);

  /**
   * POST /trp/join - Join a ring
   */
  fastify.post<{ Body: JoinRingInput }>('/join', {
    preHandler: [authenticateActor, requireVerifiedActor, requireNotBlocked()],
    schema: {
      body: {
        type: 'object',
        properties: {
          ringSlug: { type: 'string' },
          message: { type: 'string', maxLength: 500 },
          metadata: { type: 'object' },
        },
        required: ['ringSlug'],
      },
      tags: ['membership'],
      summary: 'Join a ring',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { ringSlug, message, metadata } = request.body;
      const actorDid = request.actor!.did;

      // Find the ring
      const ring = await prisma.ring.findUnique({
        where: { slug: ringSlug },
        include: {
          roles: {
            orderBy: { name: 'asc' },
          },
        },
        select: {
          id: true,
          slug: true,
          name: true,
          joinPolicy: true,
          roles: {
            orderBy: { name: 'asc' },
          },
          badgeImageUrl: true,
          badgeImageHighResUrl: true,
        },
      });

      if (!ring) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Ring not found',
        });
        return;
      }

      // Check if already a member
      const existingMembership = await prisma.membership.findFirst({
        where: {
          ringId: ring.id,
          actorDid,
        },
      });

      if (existingMembership) {
        if (existingMembership.status === 'ACTIVE') {
          reply.code(409).send({
            error: 'Already member',
            message: 'You are already a member of this ring',
          });
          return;
        } else if (existingMembership.status === 'PENDING') {
          reply.code(409).send({
            error: 'Application pending',
            message: 'Your membership application is pending approval',
          });
          return;
        }
      }

      // Check join policy
      let membershipStatus = 'PENDING';
      let requiresApproval = false;

      switch (ring.joinPolicy) {
        case 'OPEN':
          membershipStatus = 'ACTIVE';
          break;
        case 'APPLICATION':
          membershipStatus = 'PENDING';
          requiresApproval = true;
          break;
        case 'INVITATION':
          // Check if there's a pending invitation
          const invitation = await prisma.invitation.findFirst({
            where: {
              ringId: ring.id,
              inviteeDid: actorDid,
              status: 'PENDING',
              expiresAt: { gt: new Date() },
            },
          });

          if (!invitation) {
            reply.code(403).send({
              error: 'Invitation required',
              message: 'This ring requires an invitation to join',
            });
            return;
          }

          membershipStatus = 'ACTIVE';
          // Mark invitation as used
          await prisma.invitation.update({
            where: { id: invitation.id },
            data: { status: 'ACCEPTED' },
          });
          break;
        case 'CLOSED':
          reply.code(403).send({
            error: 'Ring closed',
            message: 'This ring is not accepting new members',
          });
          return;
      }

      // Get default member role - prefer 'member' role, fallback to first available
      let memberRole = ring.roles.find(role => role.name === 'member');
      if (!memberRole && ring.roles.length > 0) {
        memberRole = ring.roles[0]; // Use first available role as fallback
      }
      
      if (!memberRole) {
        reply.code(500).send({
          error: 'Configuration error',
          message: 'Ring has no roles configured',
        });
        return;
      }

      // Create or update membership
      const membership = await prisma.membership.upsert({
        where: {
          ringId_actorDid: {
            ringId: ring.id,
            actorDid,
          },
        },
        update: {
          status: membershipStatus as any,
          roleId: memberRole.id,
          joinedAt: membershipStatus === 'ACTIVE' ? new Date() : undefined,
          applicationMessage: message,
          metadata,
        },
        create: {
          ringId: ring.id,
          actorDid,
          roleId: memberRole.id,
          status: membershipStatus as any,
          joinedAt: membershipStatus === 'ACTIVE' ? new Date() : undefined,
          applicationMessage: message,
          metadata,
        },
      });

      // Generate badge if membership is active
      let badge = null;
      if (membershipStatus === 'ACTIVE') {
        try {
          const actor = await prisma.actor.findUnique({
            where: { did: actorDid },
            select: { name: true },
          });

          badge = await generateBadge(
            ring.slug,
            ring.name,
            actorDid,
            actor?.name || 'Unknown',
            memberRole.name,
            RING_HUB_PRIVATE_KEY,
            RING_HUB_URL,
            ring.badgeImageUrl || undefined,
            ring.badgeImageHighResUrl || undefined
          );

          // Store badge reference
          await prisma.membership.update({
            where: { id: membership.id },
            data: { badgeId: badge.id },
          });

          // Store badge in database
          await prisma.badge.create({
            data: {
              id: badge.id,
              membershipId: membership.id,
              badgeData: badge,
              issuedAt: new Date(),
            },
          });
        } catch (error) {
          logger.error({ error, ringSlug, actorDid }, 'Failed to generate badge');
          // Continue without badge - don't fail the join
        }
      }

      // Log the action
      await prisma.auditLog.create({
        data: {
          ringId: ring.id,
          action: requiresApproval ? 'membership.applied' : 'membership.joined',
          actorDid,
          metadata: {
            membershipId: membership.id,
            status: membershipStatus,
            message,
          },
        },
      });

      logger.info({
        ringSlug,
        actorDid,
        status: membershipStatus,
        requiresApproval,
      }, 'Ring join request processed');

      reply.code(201).send({
        membership: {
          id: membership.id,
          status: membershipStatus,
          role: memberRole.name,
          joinedAt: membership.joinedAt?.toISOString(),
          requiresApproval,
        },
        badge: badge ? {
          id: badge.id,
          url: `${RING_HUB_URL}/badges/${badge.id}`,
        } : null,
        message: requiresApproval 
          ? 'Application submitted for review'
          : 'Successfully joined ring',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to process join request');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to process join request',
      });
    }
  });

  /**
   * POST /trp/leave - Leave a ring
   */
  fastify.post<{ Body: { ringSlug: string; reason?: string } }>('/leave', {
    preHandler: [authenticateActor, requireVerifiedActor],
    schema: {
      body: {
        type: 'object',
        properties: {
          ringSlug: { type: 'string' },
          reason: { type: 'string', maxLength: 500 },
        },
        required: ['ringSlug'],
      },
      tags: ['membership'],
      summary: 'Leave a ring',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { ringSlug, reason } = request.body;
      const actorDid = request.actor!.did;

      // Find the ring
      const ring = await prisma.ring.findUnique({
        where: { slug: ringSlug },
      });

      if (!ring) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Ring not found',
        });
        return;
      }

      // Check if user is a member
      const membership = await prisma.membership.findFirst({
        where: {
          ringId: ring.id,
          actorDid,
          status: { in: ['ACTIVE', 'PENDING'] },
        },
        include: {
          role: { select: { name: true } },
        },
      });

      if (!membership) {
        reply.code(404).send({
          error: 'Not a member',
          message: 'You are not a member of this ring',
        });
        return;
      }

      // Check if user is the owner
      if (ring.ownerDid === actorDid) {
        // Check if there are other members
        const otherMembersCount = await prisma.membership.count({
          where: {
            ringId: ring.id,
            actorDid: { not: actorDid },
            status: 'ACTIVE',
          },
        });

        if (otherMembersCount > 0) {
          reply.code(400).send({
            error: 'Transfer ownership required',
            message: 'Ring owners cannot leave until ownership is transferred to another member',
          });
          return;
        }
      }

      // Revoke badge if exists
      if (membership.badgeId) {
        try {
          await revokeBadge(membership.badgeId, reason || 'Member left ring', actorDid);
          
          // Update badge status in database
          await prisma.badge.updateMany({
            where: { id: membership.badgeId },
            data: { 
              revokedAt: new Date(),
              revocationReason: reason || 'Member left ring',
            },
          });
        } catch (error) {
          logger.error({ error, badgeId: membership.badgeId }, 'Failed to revoke badge');
          // Continue with leaving - don't fail the operation
        }
      }

      // Update membership status
      await prisma.membership.update({
        where: { id: membership.id },
        data: {
          status: 'REVOKED',
          leftAt: new Date(),
          leaveReason: reason,
        },
      });

      // Log the action
      await prisma.auditLog.create({
        data: {
          ringId: ring.id,
          action: 'membership.left',
          actorDid,
          metadata: {
            membershipId: membership.id,
            reason,
            role: membership.role?.name,
          },
        },
      });

      logger.info({
        ringSlug,
        actorDid,
        reason,
      }, 'Member left ring');

      reply.code(200).send({
        message: 'Successfully left ring',
        leftAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to process leave request');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to process leave request',
      });
    }
  });

  /**
   * PUT /trp/rings/:slug/members/:did - Update member role
   */
  fastify.put<{ 
    Params: { slug: string; did: string }; 
    Body: UpdateMemberRoleInput 
  }>('/rings/:slug/members/:did', {
    preHandler: [
      authenticateActor,
      requireVerifiedActor,
      requireNotBlocked(),
      requireMembership(),
      requirePermission('manage_members'),
    ],
    schema: {
      params: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          did: { type: 'string' },
        },
        required: ['slug', 'did'],
      },
      body: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          metadata: { type: 'object' },
        },
        required: ['role'],
      },
      tags: ['membership'],
      summary: 'Update member role',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { slug, did } = request.params;
      const { role: roleName, metadata } = request.body;
      const updaterDid = request.actor!.did;

      // Find the ring
      const ring = await prisma.ring.findUnique({
        where: { slug },
      });

      if (!ring) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Ring not found',
        });
        return;
      }

      // Find the target member
      const membership = await prisma.membership.findFirst({
        where: {
          ringId: ring.id,
          actorDid: did,
          status: 'ACTIVE',
        },
        include: {
          role: { select: { name: true } },
        },
      });

      if (!membership) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Member not found',
        });
        return;
      }

      // Find the new role
      const newRole = await prisma.ringRole.findFirst({
        where: {
          ringId: ring.id,
          name: roleName,
        },
      });

      if (!newRole) {
        reply.code(400).send({
          error: 'Invalid role',
          message: 'Role not found in this ring',
        });
        return;
      }

      // Check if trying to change the owner's role
      if (ring.ownerDid === did && roleName !== 'owner') {
        reply.code(400).send({
          error: 'Cannot demote owner',
          message: 'Ring owner role cannot be changed. Transfer ownership first.',
        });
        return;
      }

      // Update membership
      const oldRole = membership.role?.name;
      await prisma.membership.update({
        where: { id: membership.id },
        data: {
          roleId: newRole.id,
          metadata: metadata ? { ...membership.metadata, ...metadata } : membership.metadata,
        },
      });

      // Log the action
      await prisma.auditLog.create({
        data: {
          ringId: ring.id,
          action: 'membership.role_updated',
          actorDid: updaterDid,
          metadata: {
            targetDid: did,
            membershipId: membership.id,
            oldRole,
            newRole: roleName,
            updateMetadata: metadata,
          },
        },
      });

      logger.info({
        ringSlug: slug,
        memberDid: did,
        updaterDid,
        oldRole,
        newRole: roleName,
      }, 'Member role updated');

      reply.send({
        message: 'Member role updated successfully',
        member: {
          actorDid: did,
          role: roleName,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to update member role');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to update member role',
      });
    }
  });

  /**
   * GET /trp/badges/:id - Get badge details
   */
  fastify.get<{ Params: { id: string } }>('/badges/:id', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      tags: ['badges'],
      summary: 'Get badge details',
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      const badge = await prisma.badge.findUnique({
        where: { id },
        include: {
          membership: {
            include: {
              ring: { select: { slug: true, name: true } },
              role: { select: { name: true } },
            },
          },
        },
      });

      if (!badge) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Badge not found',
        });
        return;
      }

      // Check if badge is revoked
      const isRevoked = await isBadgeRevoked(id) || badge.revokedAt !== null;

      reply.send({
        badge: badge.badgeData,
        metadata: {
          ring: {
            slug: badge.membership.ring.slug,
            name: badge.membership.ring.name,
          },
          role: badge.membership.role?.name,
          issuedAt: badge.issuedAt.toISOString(),
          isRevoked,
          revokedAt: badge.revokedAt?.toISOString(),
          revocationReason: badge.revocationReason,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get badge details');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to retrieve badge',
      });
    }
  });

  /**
   * POST /trp/badges/:id/verify - Verify badge signature
   */
  fastify.post<{ Params: { id: string } }>('/badges/:id/verify', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      tags: ['badges'],
      summary: 'Verify badge signature',
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      const badge = await prisma.badge.findUnique({
        where: { id },
      });

      if (!badge) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Badge not found',
        });
        return;
      }

      // Check if badge is revoked
      const isRevoked = await isBadgeRevoked(id) || badge.revokedAt !== null;

      if (isRevoked) {
        reply.send({
          isValid: false,
          error: 'Badge has been revoked',
          verifiedAt: new Date().toISOString(),
        });
        return;
      }

      // TODO: In production, get public key from DID document
      const publicKey = crypto.createPublicKey(RING_HUB_PRIVATE_KEY);
      const verification = await verifyBadge(badge.badgeData as any, publicKey);

      reply.send({
        isValid: verification.isValid,
        error: verification.error,
        verifiedAt: new Date().toISOString(),
        issuer: badge.badgeData?.issuer?.id,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to verify badge');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to verify badge',
      });
    }
  });

  /**
   * GET /trp/actors/:did/badges - Get all badges for an actor
   * Returns all active badges associated with the actor's DID
   * This is a public endpoint - no authentication required
   */
  fastify.get<{ 
    Params: { did: string };
    Querystring: { 
      status?: 'active' | 'revoked' | 'all';
      limit?: number;
      offset?: number;
    };
  }>('/actors/:did/badges', {
    schema: {
      params: {
        type: 'object',
        properties: {
          did: { type: 'string' },
        },
        required: ['did'],
      },
      querystring: {
        type: 'object',
        properties: {
          status: { 
            type: 'string', 
            enum: ['active', 'revoked', 'all'],
            default: 'active'
          },
          limit: { 
            type: 'number', 
            minimum: 1, 
            maximum: 100, 
            default: 20 
          },
          offset: { 
            type: 'number', 
            minimum: 0, 
            default: 0 
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            badges: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  badge: { type: 'object' }, // Full badge JSON-LD
                  ring: {
                    type: 'object',
                    properties: {
                      slug: { type: 'string' },
                      name: { type: 'string' },
                      visibility: { type: 'string' },
                    },
                  },
                  membership: {
                    type: 'object',
                    properties: {
                      role: { type: 'string', nullable: true },
                      joinedAt: { type: 'string', nullable: true },
                      status: { type: 'string' },
                    },
                  },
                  issuedAt: { type: 'string' },
                  isRevoked: { type: 'boolean' },
                  revokedAt: { type: 'string', nullable: true },
                  revocationReason: { type: 'string', nullable: true },
                },
              },
            },
            total: { type: 'number' },
            limit: { type: 'number' },
            offset: { type: 'number' },
            hasMore: { type: 'boolean' },
          },
        },
      },
      tags: ['badges'],
      summary: 'Get all badges for an actor',
    },
  }, async (request, reply) => {
    const { did } = request.params;
    const { status = 'active', limit = 20, offset = 0 } = request.query;
    const logger = request.log;

    try {
      // Build the where clause based on status filter
      let badgeWhere: any = {};
      let membershipWhere: any = {
        actorDid: did,
      };

      switch (status) {
        case 'active':
          badgeWhere.revokedAt = null;
          membershipWhere.status = 'ACTIVE';
          break;
        case 'revoked':
          badgeWhere.revokedAt = { not: null };
          break;
        case 'all':
          // No additional filters
          break;
      }

      // Get badges with their associated membership and ring data
      const [badges, totalCount] = await Promise.all([
        prisma.badge.findMany({
          where: {
            ...badgeWhere,
            membership: membershipWhere,
          },
          include: {
            membership: {
              include: {
                ring: {
                  select: {
                    slug: true,
                    name: true,
                    visibility: true,
                  },
                },
                role: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
          orderBy: {
            issuedAt: 'desc',
          },
          take: limit,
          skip: offset,
        }),
        prisma.badge.count({
          where: {
            ...badgeWhere,
            membership: membershipWhere,
          },
        }),
      ]);

      // Filter out badges from private rings unless the requester is a member
      // For now, we'll include all badges but this could be enhanced with authentication
      const accessibleBadges = badges.filter(badge => {
        const ring = badge.membership.ring;
        // Always show PUBLIC and UNLISTED rings
        // For PRIVATE rings, ideally we'd check if requester is a member
        return ring.visibility !== 'PRIVATE';
      });

      // Format the response
      const formattedBadges = accessibleBadges.map(badge => ({
        badge: badge.badgeData,
        ring: {
          slug: badge.membership.ring.slug,
          name: badge.membership.ring.name,
          visibility: badge.membership.ring.visibility,
        },
        membership: {
          role: badge.membership.role?.name || null,
          joinedAt: badge.membership.joinedAt?.toISOString() || null,
          status: badge.membership.status,
        },
        issuedAt: badge.issuedAt.toISOString(),
        isRevoked: badge.revokedAt !== null,
        revokedAt: badge.revokedAt?.toISOString() || null,
        revocationReason: badge.revocationReason || null,
      }));

      reply.send({
        badges: formattedBadges,
        total: accessibleBadges.length,
        limit,
        offset,
        hasMore: offset + limit < accessibleBadges.length,
      });
    } catch (error) {
      logger.error({ 
        error: error instanceof Error ? error.message : String(error),
        did 
      }, 'Failed to get actor badges');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to retrieve actor badges',
      });
    }
  });
}