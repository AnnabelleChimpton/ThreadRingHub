import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyHttpSignature } from './http-signature';
import { getActor, isActorBlocked, registerActor } from './actor-manager';
import { logger } from '../utils/logger';
import { prisma } from '../database/prisma';

// Extend FastifyRequest to include actor information
declare module 'fastify' {
  interface FastifyRequest {
    actor?: {
      did: string;
      name?: string;
      verified: boolean;
      trusted: boolean;
    };
    keyId?: string;
  }
}

/**
 * Middleware to authenticate requests using HTTP signatures
 */
export async function authenticateActor(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    logger.info({ method: request.method, url: request.url }, 'Authentication middleware called');
    
    // Skip authentication for public endpoints
    if (isPublicEndpoint(request.url, request.method)) {
      logger.info({ url: request.url, method: request.method }, 'Skipping authentication for public endpoint');
      return;
    }

    // Verify HTTP signature
    const result = await verifyHttpSignature(request);
    
    logger.info({ 
      valid: result.valid, 
      actorDid: result.actorDid, 
      error: result.error 
    }, 'HTTP signature verification result in middleware');
    
    if (!result.valid) {
      logger.warn({ 
        error: result.error, 
        method: request.method, 
        url: request.url 
      }, 'Authentication failed in middleware');
      reply.code(401).send({
        error: 'Authentication required',
        message: result.error || 'Invalid or missing signature',
      });
      return;
    }

    // Get or register actor information
    if (result.actorDid) {
      logger.info({ actorDid: result.actorDid }, 'Looking up actor information');
      let actor = await getActor(result.actorDid);
      
      logger.info({ 
        actorDid: result.actorDid, 
        existingActor: !!actor,
        verified: actor?.verified,
        trusted: actor?.trusted 
      }, 'Actor lookup result');
      
      // If actor doesn't exist, register them
      if (!actor) {
        logger.info({ did: result.actorDid }, 'Registering new actor during authentication');
        
        actor = await registerActor({
          did: result.actorDid,
          type: 'USER', // Default to USER type, can be updated later if needed
          publicKey: result.publicKey, // From HTTP signature verification
        });
        
        logger.info({ 
          did: result.actorDid, 
          registered: !!actor,
          verified: actor?.verified 
        }, 'Actor registration result');
      }
      
      if (actor) {
        request.actor = {
          did: actor.did,
          name: actor.name || undefined,
          verified: actor.verified,
          trusted: actor.trusted,
        };
        request.keyId = result.keyId;
        
        logger.info({ 
          actorDid: actor.did, 
          verified: actor.verified, 
          trusted: actor.trusted 
        }, 'Actor attached to request');
      } else {
        logger.error({ actorDid: result.actorDid }, 'Failed to get or register actor');
      }
    } else {
      logger.warn('No actor DID found in signature verification result');
    }
  } catch (error) {
    logger.error({ error }, 'Authentication middleware error');
    reply.code(500).send({
      error: 'Internal error',
      message: 'Authentication failed',
    });
  }
}

/**
 * Middleware to require verified actors
 */
export async function requireVerifiedActor(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  logger.info({ 
    hasActor: !!request.actor,
    actorDid: request.actor?.did,
    verified: request.actor?.verified,
    trusted: request.actor?.trusted 
  }, 'Checking actor verification requirement');
  
  if (!request.actor?.verified) {
    logger.warn({ 
      actorDid: request.actor?.did,
      verified: request.actor?.verified,
      hasActor: !!request.actor 
    }, 'Actor verification requirement failed');
    
    reply.code(403).send({
      error: 'Verification required',
      message: 'This action requires a verified actor',
    });
    return;
  }
  
  logger.info({ actorDid: request.actor.did }, 'Actor verification requirement passed');
}

/**
 * Middleware to require trusted actors
 */
export async function requireTrustedActor(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.actor?.trusted) {
    reply.code(403).send({
      error: 'Trust required',
      message: 'This action requires a trusted actor',
    });
    return;
  }
}

/**
 * Middleware to check if actor is blocked from a specific ring
 */
export function requireNotBlocked(ringParam: string = 'slug') {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.actor) {
      return; // Authentication middleware should handle this
    }

    // Try to get ring slug from params first, then body
    let ringSlug = (request.params as any)[ringParam];
    if (!ringSlug && request.body) {
      // For endpoints like /join where ring slug is in body
      ringSlug = (request.body as any).ringSlug || (request.body as any)[ringParam];
    }
    
    if (!ringSlug) {
      reply.code(400).send({
        error: 'Invalid request',
        message: 'Ring identifier required',
      });
      return;
    }

    try {
      // Get ring ID from slug
      const ring = await prisma.ring.findUnique({
        where: { slug: ringSlug },
        select: { id: true },
      });

      if (!ring) {
        reply.code(404).send({
          error: 'Not found',
          message: 'Ring not found',
        });
        return;
      }

      // Check if actor is blocked
      const blocked = await isActorBlocked(request.actor.did, ring.id);
      if (blocked) {
        reply.code(403).send({
          error: 'Access denied',
          message: 'You are blocked from this ring',
        });
        return;
      }
    } catch (error) {
      logger.error({ error, ringSlug }, 'Error checking block status');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to check access permissions',
      });
    }
  };
}

/**
 * Middleware to check ring membership
 */
export function requireMembership(ringParam: string = 'slug') {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.actor) {
      return; // Authentication middleware should handle this
    }

    const ringSlug = (request.params as any)[ringParam];
    if (!ringSlug) {
      reply.code(400).send({
        error: 'Invalid request',
        message: 'Ring identifier required',
      });
      return;
    }

    try {
      // Check membership
      const membership = await prisma.membership.findFirst({
        where: {
          ring: { slug: ringSlug },
          actorDid: request.actor.did,
          status: 'ACTIVE',
        },
        include: {
          ring: { select: { id: true, name: true } },
          role: { select: { name: true, permissions: true } },
        },
      });

      if (!membership) {
        reply.code(403).send({
          error: 'Access denied',
          message: 'Ring membership required',
        });
        return;
      }

      // Attach membership info to request
      (request as any).membership = {
        ringId: membership.ring.id,
        ringName: membership.ring.name,
        role: membership.role?.name,
        permissions: membership.role?.permissions || [],
      };
    } catch (error) {
      logger.error({ error, ringSlug }, 'Error checking membership');
      reply.code(500).send({
        error: 'Internal error',
        message: 'Failed to check membership',
      });
    }
  };
}

/**
 * Middleware to check specific permissions
 */
export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const membership = (request as any).membership;
    
    if (!membership) {
      reply.code(403).send({
        error: 'Access denied',
        message: 'Ring membership required',
      });
      return;
    }

    const hasPermission = membership.permissions.includes(permission);
    if (!hasPermission) {
      reply.code(403).send({
        error: 'Insufficient permissions',
        message: `This action requires the '${permission}' permission`,
      });
      return;
    }
  };
}

/**
 * Check if an endpoint is public (doesn't require authentication)
 */
function isPublicEndpoint(url: string, method?: string): boolean {
  const publicPaths = [
    '/health',
    '/health/live',
    '/health/ready',
    '/docs',
    '/documentation',
  ];

  // Check exact matches for always-public endpoints
  if (publicPaths.some(path => url === path || url.startsWith(path + '?'))) {
    return true;
  }

  // Ring discovery endpoints are public for GET requests only
  if (method === 'GET') {
    const getPublicPaths = [
      '/trp/rings',
      '/trp/rings/trending',
      '/trp/stats',
    ];
    
    if (getPublicPaths.some(path => url === path || url.startsWith(path + '?'))) {
      return true;
    }
    
    // Individual ring info is public for GET requests
    if (url.match(/^\/trp\/rings\/[^\/]+$/)) {
      return true; // GET /trp/rings/{slug} is public
    }
  }

  return false;
}

/**
 * Rate limiting by actor DID
 */
export async function actorRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // This would integrate with Redis to track per-actor rate limits
  // For now, we'll rely on the global rate limiting configured in the main app
}

/**
 * Log all actor actions for audit trail
 */
export async function auditLogger(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip logging for health checks and docs
  if (isPublicEndpoint(request.url, request.method) && !request.url.startsWith('/trp/')) {
    return;
  }

  const originalSend = reply.send.bind(reply);
  reply.send = function(payload: any) {
    // Log the action after response
    setImmediate(() => {
      logger.info({
        method: request.method,
        url: request.url,
        actorDid: request.actor?.did,
        statusCode: reply.statusCode,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      }, 'Actor action');
    });

    return originalSend(payload);
  };
}