import { FastifyInstance } from 'fastify';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { authenticateActor, requireVerifiedActor } from '../security/middleware';
import { RateLimitingService } from '../services/rate-limiting';

/**
 * Admin-only routes for managing rate limits and violations
 */
export async function adminRoutes(fastify: FastifyInstance) {
  // Middleware to ensure only admins can access these routes
  const requireAdmin = async (request: any, reply: any) => {
    if (!request.actor?.did) {
      reply.code(401).send({
        error: 'Authentication required',
        message: 'Must be authenticated to access admin routes'
      });
      return;
    }

    const isAdmin = await RateLimitingService.isAdmin(request.actor.did);
    if (!isAdmin) {
      reply.code(403).send({
        error: 'Forbidden',
        message: 'Admin access required'
      });
      return;
    }
  };

  /**
   * GET /admin/flagged-users - Get users flagged for review
   */
  fastify.get('/flagged-users', {
    preHandler: [authenticateActor, requireVerifiedActor, requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Get users flagged for review',
      security: [{ httpSignature: [] }],
    }
  }, async (_request, reply) => {
    try {
      const flaggedUsers = await RateLimitingService.getFlaggedUsers();
      reply.send({ flaggedUsers });
    } catch (error) {
      logger.error({ error }, 'Failed to get flagged users');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to retrieve flagged users'
      });
    }
  });

  /**
   * POST /admin/clear-violations/:actorDid - Clear user violations and flags
   */
  fastify.post<{ Params: { actorDid: string } }>('/clear-violations/:actorDid', {
    preHandler: [authenticateActor, requireVerifiedActor, requireAdmin],
    schema: {
      params: {
        type: 'object',
        properties: {
          actorDid: { type: 'string' }
        },
        required: ['actorDid']
      },
      tags: ['admin'],
      summary: 'Clear user violations and flags',
      security: [{ httpSignature: [] }],
    }
  }, async (request, reply) => {
    try {
      const { actorDid } = request.params;
      const adminDid = request.actor!.did;

      await RateLimitingService.clearViolations(actorDid);

      logger.info({
        targetActorDid: actorDid,
        adminDid,
        action: 'clear_violations'
      }, 'Admin cleared user violations');

      reply.send({
        success: true,
        message: 'User violations cleared successfully'
      });
    } catch (error) {
      logger.error({ error }, 'Failed to clear user violations');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to clear violations'
      });
    }
  });

  /**
   * POST /admin/apply-cooldown/:actorDid - Apply cooldown to user
   */
  fastify.post<{
    Params: { actorDid: string },
    Body: { hours?: number, reason?: string }
  }>('/apply-cooldown/:actorDid', {
    preHandler: [authenticateActor, requireVerifiedActor, requireAdmin],
    schema: {
      params: {
        type: 'object',
        properties: {
          actorDid: { type: 'string' }
        },
        required: ['actorDid']
      },
      body: {
        type: 'object',
        properties: {
          hours: { type: 'number', minimum: 1, maximum: 168, default: 24 }, // Max 1 week
          reason: { type: 'string', maxLength: 500 }
        }
      },
      tags: ['admin'],
      summary: 'Apply cooldown to user',
      security: [{ httpSignature: [] }],
    }
  }, async (request, reply) => {
    try {
      const { actorDid } = request.params;
      const { hours = 24, reason } = request.body;
      const adminDid = request.actor!.did;

      await RateLimitingService.applyCooldown(actorDid, hours);

      // Log the admin action
      await prisma.auditLog.create({
        data: {
          ringId: '00000000-0000-0000-0000-000000000000', // System action
          action: 'admin.apply_cooldown',
          actorDid: adminDid,
          targetDid: actorDid,
          metadata: {
            hours,
            reason: reason || 'Admin applied cooldown',
            cooldownUntil: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
          }
        }
      });

      logger.info({
        targetActorDid: actorDid,
        adminDid,
        hours,
        reason,
        action: 'apply_cooldown'
      }, 'Admin applied cooldown to user');

      reply.send({
        success: true,
        message: `Cooldown applied for ${hours} hours`,
        cooldownUntil: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
      });
    } catch (error) {
      logger.error({ error }, 'Failed to apply cooldown');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to apply cooldown'
      });
    }
  });

  /**
   * POST /admin/make-admin/:actorDid - Grant admin status to user
   */
  fastify.post<{ Params: { actorDid: string } }>('/make-admin/:actorDid', {
    preHandler: [authenticateActor, requireVerifiedActor, requireAdmin],
    schema: {
      params: {
        type: 'object',
        properties: {
          actorDid: { type: 'string' }
        },
        required: ['actorDid']
      },
      tags: ['admin'],
      summary: 'Grant admin status to user',
      security: [{ httpSignature: [] }],
    }
  }, async (request, reply) => {
    try {
      const { actorDid } = request.params;
      const adminDid = request.actor!.did;

      await prisma.actor.update({
        where: { did: actorDid },
        data: { isAdmin: true }
      });

      logger.info({
        targetActorDid: actorDid,
        adminDid,
        action: 'grant_admin'
      }, 'Admin granted admin status to user');

      reply.send({
        success: true,
        message: 'Admin status granted successfully'
      });
    } catch (error) {
      logger.error({ error }, 'Failed to grant admin status');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to grant admin status'
      });
    }
  });

  /**
   * DELETE /admin/revoke-admin/:actorDid - Revoke admin status from user
   */
  fastify.delete<{ Params: { actorDid: string } }>('/revoke-admin/:actorDid', {
    preHandler: [authenticateActor, requireVerifiedActor, requireAdmin],
    schema: {
      params: {
        type: 'object',
        properties: {
          actorDid: { type: 'string' }
        },
        required: ['actorDid']
      },
      tags: ['admin'],
      summary: 'Revoke admin status from user',
      security: [{ httpSignature: [] }],
    }
  }, async (request, reply) => {
    try {
      const { actorDid } = request.params;
      const adminDid = request.actor!.did;

      // Don't allow self-revocation
      if (actorDid === adminDid) {
        reply.code(400).send({
          error: 'Invalid action',
          message: 'Cannot revoke your own admin status'
        });
        return;
      }

      await prisma.actor.update({
        where: { did: actorDid },
        data: { isAdmin: false }
      });

      logger.info({
        targetActorDid: actorDid,
        adminDid,
        action: 'revoke_admin'
      }, 'Admin revoked admin status from user');

      reply.send({
        success: true,
        message: 'Admin status revoked successfully'
      });
    } catch (error) {
      logger.error({ error }, 'Failed to revoke admin status');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to revoke admin status'
      });
    }
  });

  /**
   * GET /admin/users - Search for users by name or DID
   */
  fastify.get<{
    Querystring: {
      search?: string;
      limit?: number;
      offset?: number;
    }
  }>('/users', {
    preHandler: [authenticateActor, requireVerifiedActor, requireAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'number', minimum: 0, default: 0 }
        }
      },
      tags: ['admin'],
      summary: 'Search for users by name or DID',
      security: [{ httpSignature: [] }],
    }
  }, async (request, reply) => {
    try {
      const { search, limit = 20, offset = 0 } = request.query;

      const where: any = { type: 'USER' };

      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { did: { contains: search, mode: 'insensitive' } }
        ];
      }

      const [users, total] = await Promise.all([
        prisma.actor.findMany({
          where,
          select: {
            did: true,
            name: true,
            verified: true,
            trusted: true,
            isAdmin: true,
            discoveredAt: true,
            lastSeenAt: true
          },
          take: limit,
          skip: offset,
          orderBy: { discoveredAt: 'desc' }
        }),
        prisma.actor.count({ where })
      ]);

      reply.send({
        users,
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      });
    } catch (error) {
      logger.error({ error }, 'Failed to search users');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to search users'
      });
    }
  });

  /**
   * GET /admin/user-stats/:actorDid - Get detailed user statistics
   */
  fastify.get<{ Params: { actorDid: string } }>('/user-stats/:actorDid', {
    preHandler: [authenticateActor, requireVerifiedActor, requireAdmin],
    schema: {
      params: {
        type: 'object',
        properties: {
          actorDid: { type: 'string' }
        },
        required: ['actorDid']
      },
      tags: ['admin'],
      summary: 'Get detailed user statistics',
      security: [{ httpSignature: [] }],
    }
  }, async (request, reply) => {
    try {
      const { actorDid } = request.params;

      const [actor, reputation, recentForks] = await Promise.all([
        prisma.actor.findUnique({ where: { did: actorDid } }),
        prisma.actorReputation.findUnique({ where: { actorDid } }),
        prisma.rateLimit.findMany({
          where: {
            actorDid,
            action: 'fork_ring',
            performedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          },
          orderBy: { performedAt: 'desc' },
          take: 50
        })
      ]);

      if (!actor) {
        reply.code(404).send({
          error: 'Not found',
          message: 'User not found'
        });
        return;
      }

      // Calculate recent activity
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const forksThisWeek = recentForks.filter(f => f.performedAt >= weekAgo).length;

      reply.send({
        actor,
        reputation,
        activity: {
          forksThisWeek,
          forksThisMonth: recentForks.length,
          recentForks: recentForks.slice(0, 10) // Last 10 forks
        }
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get user stats');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to retrieve user statistics'
      });
    }
  });
}