import { FastifyInstance } from 'fastify';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { authenticateActor, requireVerifiedActor, requireNotBlocked, requireMembership, requirePermission, auditLogger } from '../security/middleware';
import {
  SubmitPostInput,
  CuratePostInput,
  PostQueryInput,
  AuditQueryInput,
  PostResponse,
  PostsListResponse,
  AuditListResponse
} from '../schemas/ring-schemas';

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
          metadata: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 200 },
              textPreview: { type: 'string', maxLength: 300 },
              excerpt: { type: 'string', maxLength: 500 },
              tags: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 10
              },
              publishedAt: { type: 'string', format: 'date-time' },
              platform: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        required: ['ringSlug', 'uri', 'digest'],
      },
      tags: ['content'],
      summary: 'Submit content to a ring',
      description: 'Submit content to a ThreadRing. Includes validation for metadata fields like textPreview (max 300 chars).',
      security: [{ httpSignature: [] }],
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            ringSlug: { type: 'string' },
            uri: { type: 'string' },
            digest: { type: 'string' },
            actorDid: { type: 'string' },
            submittedBy: { type: 'string' },
            submittedAt: { type: 'string', format: 'date-time' },
            status: { type: 'string', enum: ['PENDING', 'ACCEPTED'] },
            moderatedAt: { type: 'string', format: 'date-time' },
            moderatedBy: { type: 'string' },
            metadata: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                textPreview: { type: 'string' },
                excerpt: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                publishedAt: { type: 'string', format: 'date-time' },
                platform: { type: 'string' },
              },
            },
          },
        },
      },
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

          // Allow admins to bypass membership requirement
          if (!membership && !request.actor!.isAdmin) {
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
          scope: { type: 'string', enum: ['ring', 'parent', 'children', 'siblings', 'family'], default: 'ring' },
        },
      },
      tags: ['content'],
      summary: 'Get ring feed',
    },
  }, async (request, reply) => {
    try {
      const { slug } = request.params;
      const { limit, offset, status, actorDid, since, until, pinned, scope } = request.query;

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

      // Build ring IDs based on scope
      let ringIds: string[] = [ring.id];

      if (scope === 'parent') {
        // Get only the parent ring
        if (ring.parentId) {
          ringIds = [ring.parentId];
        } else {
          ringIds = []; // Root ring has no parent
        }
      } else if (scope === 'children') {
        // Get all direct children
        const children = await prisma.ring.findMany({
          where: { parentId: ring.id },
          select: { id: true },
        });
        ringIds = children.map(child => child.id);
      } else if (scope === 'siblings') {
        // Get all rings with same parent, excluding current ring
        if (ring.parentId) {
          const siblings = await prisma.ring.findMany({
            where: {
              parentId: ring.parentId,
              id: { not: ring.id }
            },
            select: { id: true },
          });
          ringIds = siblings.map(sibling => sibling.id);
        } else {
          ringIds = []; // Root ring has no siblings
        }
      } else if (scope === 'family') {
        // Get parent + siblings + current + direct children
        const familyIds = [ring.id]; // Current ring

        // Add parent
        if (ring.parentId) {
          familyIds.push(ring.parentId);

          // Add siblings (same parent, excluding self)
          const siblings = await prisma.ring.findMany({
            where: {
              parentId: ring.parentId,
              id: { not: ring.id }
            },
            select: { id: true },
          });
          familyIds.push(...siblings.map(s => s.id));
        }

        // Add direct children
        const children = await prisma.ring.findMany({
          where: { parentId: ring.id },
          select: { id: true },
        });
        familyIds.push(...children.map(c => c.id));

        ringIds = familyIds;
      }

      // Build query filters
      const where: any = {
        ringId: ringIds.length === 1 ? ringIds[0] : { in: ringIds }
      };

      // Show posts based on authentication and membership
      if (!request.actor) {
        // Non-authenticated users only see accepted posts
        where.status = 'ACCEPTED';
      } else {
        // For scope other than 'ring', check membership of the requested ring
        // For 'ring' scope, check membership of the specific ring
        let membershipCheckRingId = ring.id;

        const membership = await prisma.membership.findFirst({
          where: {
            ringId: membershipCheckRingId,
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
   * Allows both moderators and post authors to manage content
   */
  fastify.post<{
    Body: CuratePostInput & { postId: string }
  }>('/curate', {
    preHandler: [
      authenticateActor,
      requireVerifiedActor,
      requireNotBlocked(),
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
      summary: 'Moderate/curate content (moderators can do all actions, authors can remove their own posts)',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { postId, action, reason, metadata } = request.body;
      const actorDid = request.actor!.did;

      // Find the post
      const postRef = await prisma.postRef.findUnique({
        where: { id: postId },
        include: {
          ring: { select: { slug: true, id: true } },
        },
      });

      if (!postRef) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Post not found',
        });
        return;
      }

      // Check permissions
      const isAuthor = postRef.actorDid === actorDid || postRef.submittedBy === actorDid;

      if (isAuthor) {
        if (action !== 'remove') {
          reply.code(403).send({
            error: 'Forbidden',
            message: 'Authors can only remove their own posts. Other actions require moderation permissions.',
          });
          return;
        }

        // Author removal - removes from ALL rings
        // Find all instances of this content across all rings
        const allPostRefs = await prisma.postRef.findMany({
          where: {
            uri: postRef.uri,
            actorDid: postRef.actorDid,
          },
          include: {
            ring: { select: { slug: true, id: true } },
          },
        });

        // Update all instances
        await prisma.postRef.updateMany({
          where: {
            uri: postRef.uri,
            actorDid: postRef.actorDid,
          },
          data: {
            status: 'REMOVED',
            moderatedAt: new Date(),
            moderatedBy: actorDid,
            moderationNote: reason || 'Removed by author from all rings',
          },
        });

        // Log the action for each ring
        const auditLogs = allPostRefs.map(ref => ({
          ringId: ref.ringId,
          action: 'content.author_removed_globally',
          actorDid: actorDid,
          targetDid: null,
          metadata: {
            postId: ref.id,
            uri: ref.uri,
            reason: reason || 'Removed by author from all rings',
            isAuthorAction: true,
            affectedRings: allPostRefs.map(r => r.ring.slug),
            totalRemoved: allPostRefs.length,
          },
        }));

        await prisma.auditLog.createMany({
          data: auditLogs,
        });

        logger.info({
          postId,
          uri: postRef.uri,
          actorDid,
          affectedRings: allPostRefs.map(r => r.ring.slug),
          totalRemoved: allPostRefs.length,
        }, 'Author removed content from all rings');

        // Return the updated post info (just the one requested)
        const updatedPost = await prisma.postRef.findUnique({
          where: { id: postId },
          include: {
            ring: { select: { slug: true } },
          },
        });

        reply.send({
          post: buildPostResponse(updatedPost!),
          action: 'remove',
          moderator: 'author',
          moderatedAt: new Date().toISOString(),
          reason: reason || 'Removed by author from all rings',
          isAuthorAction: true,
          globalRemoval: true,
          affectedRings: allPostRefs.map(r => ({
            id: r.ring.id,
            slug: r.ring.slug
          })),
          totalRemoved: allPostRefs.length,
        });
        return;
      }

      // Not author - check moderation permissions
      const membership = await prisma.membership.findFirst({
        where: {
          ringId: postRef.ring.id,
          actorDid: actorDid,
          status: 'ACTIVE',
        },
        include: {
          role: {
            select: { permissions: true },
          },
        },
      });

      if (!membership) {
        reply.code(403).send({
          error: 'Forbidden',
          message: 'You must be a member of this ring to moderate content',
        });
        return;
      }

      // Check if member has moderate_posts permission
      const permissions = (membership.role?.permissions as string[]) || [];
      if (!permissions.includes('moderate_posts')) {
        reply.code(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to moderate content in this ring',
        });
        return;
      }

      // Process moderator actions (only affects single ring)
      let updateData: any = {
        moderatedAt: new Date(),
        moderatedBy: actorDid,
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

      // Update only the specific post in this ring
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
          actorDid: actorDid,
          targetDid: postRef.actorDid !== actorDid ? postRef.actorDid : null,
          metadata: {
            postId,
            uri: postRef.uri,
            reason,
            isModeratorAction: true,
            ringSpecific: true,
            ...metadata,
          },
        },
      });

      logger.info({
        postId,
        action,
        actorDid,
        ringSlug: postRef.ring.slug,
        reason,
      }, 'Content moderated in specific ring');

      reply.send({
        post: buildPostResponse(updatedPost),
        action,
        moderator: actorDid,
        moderatedAt: updateData.moderatedAt.toISOString(),
        reason,
        isAuthorAction: false,
        ringSpecific: true,
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
      requirePermission('view_audit_log'),
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
          targetDid: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
        },
      },
      tags: ['audit'],
      summary: 'Get audit log',
      security: [{ httpSignature: [] }],
    },
  }, async (request, reply) => {
    try {
      const { slug } = request.params;
      const { limit, offset, action, actorDid, targetDid, since, until } = request.query;

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
      const where: any = {
        ringId: ring.id,
      };

      if (action) where.action = action;
      if (actorDid) where.actorDid = actorDid;
      if (targetDid) where.targetDid = targetDid;

      if (since) {
        where.timestamp = { ...where.timestamp, gte: new Date(since) };
      }

      if (until) {
        where.timestamp = { ...where.timestamp, lte: new Date(until) };
      }

      // Get audit logs
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: { timestamp: 'desc' },
        }),
        prisma.auditLog.count({ where }),
      ]);

      const response: AuditListResponse = {
        entries: logs.map(log => ({
          id: log.id,
          ringId: log.ringId,
          action: log.action,
          actorDid: log.actorDid,
          targetDid: log.targetDid,
          metadata: log.metadata as Record<string, any>,
          timestamp: log.timestamp.toISOString(),
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