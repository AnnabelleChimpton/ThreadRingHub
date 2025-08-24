import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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
  SubmitPostSchema,
  CuratePostSchema,
  PostQuerySchema,
  AuditQuerySchema,
  type SubmitPostInput,
  type CuratePostInput,
  type PostQueryInput,
  type AuditQueryInput,
  type PostResponse,
  type PostsListResponse,
  type AuditListResponse,
} from '../schemas/ring-schemas';

/**
 * Build post response from database record
 */
function buildPostResponse(postRef: any): PostResponse {
  return {
    id: postRef.id,
    ringSlug: postRef.ring.slug,
    uri: postRef.uri,
    digest: postRef.digest,
    actorDid: postRef.actorDid,
    submittedAt: postRef.submittedAt.toISOString(),
    submittedBy: postRef.submittedBy,
    status: postRef.status,
    moderatedAt: postRef.moderatedAt?.toISOString() || null,
    moderatedBy: postRef.moderatedBy,
    moderationNote: postRef.moderationNote,
    pinned: postRef.pinned,
    metadata: postRef.metadata,
  };
}

export async function contentRoutes(fastify: FastifyInstance) {
  // Add security middleware to all routes
  fastify.addHook('preHandler', auditLogger);

  /**
   * POST /trp/submit - Submit content to a ring
   */
  fastify.post<{ Body: SubmitPostInput }>('/submit', {
    preHandler: [authenticateActor, requireVerifiedActor, requireNotBlocked()],
    schema: {
      body: {
        type: 'object',
        properties: {
          ringSlug: { type: 'string' },
          uri: { type: 'string', format: 'uri' },
          digest: { type: 'string' },
          actorDid: { type: 'string' },
          metadata: { type: 'object' },
        },
        required: ['ringSlug', 'uri', 'digest'],
      },
      tags: ['content'],
      summary: 'Submit content to a ring',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { ringSlug, uri, digest, actorDid, metadata } = request.body;
      const submitterDid = request.actor!.did;
      const contentAuthorDid = actorDid || submitterDid;

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

      // Check post policy
      let requiresApproval = false;
      
      switch (ring.postPolicy) {
        case 'CLOSED':
          reply.code(403).send({
            error: 'Submissions closed',
            message: 'This ring is not accepting new submissions',
          });
          return;
        case 'CURATED':
          requiresApproval = true;
          break;
        case 'MEMBERS':
          // Check if submitter is a member
          const membership = await prisma.membership.findFirst({
            where: {
              ringId: ring.id,
              actorDid: submitterDid,
              status: 'ACTIVE',
            },
          });

          if (!membership) {
            reply.code(403).send({
              error: 'Members only',
              message: 'Only ring members can submit content',
            });
            return;
          }
          break;
        case 'OPEN':
          // Anyone can submit
          break;
      }

      // Check for duplicate submissions
      const existingPost = await prisma.postRef.findFirst({
        where: {
          ringId: ring.id,
          uri,
        },
      });

      if (existingPost) {
        reply.code(409).send({
          error: 'Duplicate submission',
          message: 'This content has already been submitted to this ring',
          existingPost: buildPostResponse({ ...existingPost, ring }),
        });
        return;
      }

      // Create the post reference
      const postRef = await prisma.postRef.create({
        data: {
          ringId: ring.id,
          uri,
          digest,
          actorDid: contentAuthorDid,
          submittedBy: submitterDid,
          status: requiresApproval ? 'PENDING' : 'ACCEPTED',
          moderatedAt: requiresApproval ? null : new Date(),
          moderatedBy: requiresApproval ? null : submitterDid,
          metadata,
        },
        include: {
          ring: { select: { slug: true } },
        },
      });

      // Log the action
      await prisma.auditLog.create({
        data: {
          ringId: ring.id,
          action: 'content.submitted',
          actorDid: submitterDid,
          targetDid: contentAuthorDid !== submitterDid ? contentAuthorDid : null,
          metadata: {
            postId: postRef.id,
            uri,
            digest,
            requiresApproval,
          },
        },
      });

      logger.info({
        ringSlug,
        postId: postRef.id,
        submitterDid,
        contentAuthorDid,
        uri,
        requiresApproval,
      }, 'Content submitted to ring');

      reply.code(201).send({
        post: buildPostResponse(postRef),
        message: requiresApproval 
          ? 'Content submitted for moderation'
          : 'Content accepted',
        requiresApproval,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to submit content');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to submit content',
      });
    }
  });

  /**
   * GET /trp/rings/:slug/feed - Get ring feed
   */
  fastify.get<{ 
    Params: { slug: string }; 
    Querystring: PostQueryInput 
  }>('/rings/:slug/feed', {
    schema: {
      params: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'number', minimum: 0, default: 0 },
          status: { type: 'string', enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'REMOVED'] },
          actorDid: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
          pinned: { type: 'boolean' },
        },
      },
      tags: ['content'],
      summary: 'Get ring feed',
    },
  }, async (request, reply) => {
    try {
      const { slug } = request.params;
      const { limit, offset, status, actorDid, since, until, pinned } = request.query;

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

      // Check visibility permissions
      if (ring.visibility === 'PRIVATE' && !request.actor) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Ring not found',
        });
        return;
      }

      if (ring.visibility === 'PRIVATE' && request.actor) {
        // Check if user is a member
        const membership = await prisma.membership.findFirst({
          where: {
            ringId: ring.id,
            actorDid: request.actor.did,
            status: 'ACTIVE',
          },
        });

        if (!membership) {
          reply.code(404).send({
            error: 'Not found',
            message: 'Ring not found',
          });
          return;
        }
      }

      // Build query filters
      const where: any = { ringId: ring.id };

      // Show posts based on authentication and membership
      if (!request.actor) {
        // Non-authenticated users only see accepted posts
        where.status = 'ACCEPTED';
      } else {
        // Check if authenticated user is a member
        const membership = await prisma.membership.findFirst({
          where: {
            ringId: ring.id,
            actorDid: request.actor.did,
            status: 'ACTIVE',
          },
        });
        
        if (membership) {
          // Members can see all posts for moderation, unless status filter specified
          if (status) where.status = status;
          // Otherwise show all posts (PENDING, ACCEPTED, REJECTED)
        } else {
          // Non-members only see accepted posts
          where.status = 'ACCEPTED';
        }
      }

      if (actorDid) {
        where.actorDid = actorDid;
      }

      if (since) {
        where.submittedAt = { ...where.submittedAt, gte: new Date(since) };
      }

      if (until) {
        where.submittedAt = { ...where.submittedAt, lte: new Date(until) };
      }

      if (pinned !== undefined) {
        where.pinned = pinned;
      }

      // Get posts with pagination
      const [posts, total] = await Promise.all([
        prisma.postRef.findMany({
          where,
          include: {
            ring: { select: { slug: true } },
          },
          take: limit,
          skip: offset,
          orderBy: [
            { pinned: 'desc' }, // Pinned posts first
            { submittedAt: 'desc' },
          ],
        }),
        prisma.postRef.count({ where }),
      ]);

      const response: PostsListResponse = {
        posts: posts.map(buildPostResponse),
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      };

      reply.send(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get ring feed');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to retrieve ring feed',
      });
    }
  });

  /**
   * GET /trp/rings/:slug/queue - Get moderation queue
   */
  fastify.get<{ 
    Params: { slug: string }; 
    Querystring: PostQueryInput 
  }>('/rings/:slug/queue', {
    preHandler: [
      authenticateActor,
      requireVerifiedActor,
      requireNotBlocked(),
      requireMembership(),
      requirePermission('moderate_posts'),
    ],
    schema: {
      params: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'number', minimum: 0, default: 0 },
        },
      },
      tags: ['content'],
      summary: 'Get moderation queue',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { slug } = request.params;
      const { limit, offset } = request.query;

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

      // Get pending posts
      const [posts, total] = await Promise.all([
        prisma.postRef.findMany({
          where: {
            ringId: ring.id,
            status: 'PENDING',
          },
          include: {
            ring: { select: { slug: true } },
          },
          take: limit,
          skip: offset,
          orderBy: { submittedAt: 'asc' }, // Oldest first for moderation
        }),
        prisma.postRef.count({
          where: {
            ringId: ring.id,
            status: 'PENDING',
          },
        }),
      ]);

      const response: PostsListResponse = {
        posts: posts.map(buildPostResponse),
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      };

      reply.send(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get moderation queue');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to retrieve moderation queue',
      });
    }
  });

  /**
   * POST /trp/curate - Moderate/curate content
   */
  fastify.post<{ 
    Body: CuratePostInput & { postId: string } 
  }>('/curate', {
    preHandler: [
      authenticateActor,
      requireVerifiedActor,
      requireNotBlocked(),
      requireMembership(),
      requirePermission('moderate_posts'),
    ],
    schema: {
      body: {
        type: 'object',
        properties: {
          postId: { type: 'string' },
          action: { type: 'string', enum: ['accept', 'reject', 'pin', 'unpin', 'remove'] },
          reason: { type: 'string', maxLength: 500 },
          metadata: { type: 'object' },
        },
        required: ['postId', 'action'],
      },
      tags: ['content'],
      summary: 'Moderate/curate content',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { postId, action, reason, metadata } = request.body;
      const moderatorDid = request.actor!.did;

      // Find the post
      const postRef = await prisma.postRef.findUnique({
        where: { id: postId },
        include: {
          ring: { select: { slug: true } },
        },
      });

      if (!postRef) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Post not found',
        });
        return;
      }

      // Process the moderation action
      let updateData: any = {
        moderatedAt: new Date(),
        moderatedBy: moderatorDid,
        moderationNote: reason,
      };

      switch (action) {
        case 'accept':
          updateData.status = 'ACCEPTED';
          break;
        case 'reject':
          updateData.status = 'REJECTED';
          break;
        case 'remove':
          updateData.status = 'REMOVED';
          break;
        case 'pin':
          updateData.pinned = true;
          break;
        case 'unpin':
          updateData.pinned = false;
          break;
        default:
          reply.code(400).send({
            error: 'Invalid action',
            message: 'Unsupported moderation action',
          });
          return;
      }

      // Update the post
      const updatedPost = await prisma.postRef.update({
        where: { id: postId },
        data: updateData,
        include: {
          ring: { select: { slug: true } },
        },
      });

      // Log the action
      await prisma.auditLog.create({
        data: {
          ringId: postRef.ringId,
          action: `content.${action}`,
          actorDid: moderatorDid,
          targetDid: postRef.actorDid,
          metadata: {
            postId,
            uri: postRef.uri,
            reason,
            ...metadata,
          },
        },
      });

      logger.info({
        postId,
        action,
        moderatorDid,
        ringSlug: postRef.ring.slug,
        reason,
      }, 'Content moderated');

      reply.send({
        post: buildPostResponse(updatedPost),
        action,
        moderator: moderatorDid,
        moderatedAt: updateData.moderatedAt.toISOString(),
        reason,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to moderate content');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to moderate content',
      });
    }
  });

  /**
   * GET /trp/rings/:slug/audit - Get audit log
   */
  fastify.get<{ 
    Params: { slug: string }; 
    Querystring: AuditQueryInput 
  }>('/rings/:slug/audit', {
    preHandler: [
      authenticateActor,
      requireVerifiedActor,
      requireNotBlocked(),
      requireMembership(),
      requirePermission('manage_ring'),
    ],
    schema: {
      params: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'number', minimum: 0, default: 0 },
          action: { type: 'string' },
          actorDid: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
        },
      },
      tags: ['content'],
      summary: 'Get audit log',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { slug } = request.params;
      const { limit, offset, action, actorDid, since, until } = request.query;

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

      // Build query filters
      const where: any = { ringId: ring.id };

      if (action) {
        where.action = { contains: action };
      }

      if (actorDid) {
        where.actorDid = actorDid;
      }

      if (since) {
        where.timestamp = { ...where.timestamp, gte: new Date(since) };
      }

      if (until) {
        where.timestamp = { ...where.timestamp, lte: new Date(until) };
      }

      // Get audit entries
      const [entries, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: { timestamp: 'desc' },
        }),
        prisma.auditLog.count({ where }),
      ]);

      const response: AuditListResponse = {
        entries: entries.map(entry => ({
          id: entry.id,
          action: entry.action,
          actorDid: entry.actorDid,
          targetDid: entry.targetDid,
          timestamp: entry.timestamp.toISOString(),
          metadata: entry.metadata,
        })),
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      };

      reply.send(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get audit log');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to retrieve audit log',
      });
    }
  });
}