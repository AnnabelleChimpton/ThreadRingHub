import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimitingService } from '../services/rate-limiting';
import { logger } from '../utils/logger';

export interface RateLimitOptions {
  action: string;
  skipSuccessfulResponse?: boolean;
}

/**
 * Rate limiting middleware factory
 */
export function rateLimit(options: RateLimitOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.actor?.did) {
      reply.code(401).send({
        error: 'Authentication required',
        message: 'Rate limiting requires authentication'
      });
      return;
    }

    const actorDid = request.actor.did;

    try {
      let rateLimitResult;

      switch (options.action) {
        case 'fork_ring':
          rateLimitResult = await RateLimitingService.checkForkLimit(actorDid);
          break;
        default:
          throw new Error(`Unknown rate limit action: ${options.action}`);
      }

      // Add rate limit headers
      reply.headers({
        'X-RateLimit-Limit-Hourly': rateLimitResult.remaining.hourly + 
          (rateLimitResult.remaining.hourly === 0 ? 0 : 1),
        'X-RateLimit-Limit-Daily': rateLimitResult.remaining.daily + 
          (rateLimitResult.remaining.daily === 0 ? 0 : 1),
        'X-RateLimit-Remaining-Hourly': rateLimitResult.remaining.hourly,
        'X-RateLimit-Remaining-Daily': rateLimitResult.remaining.daily,
        'X-RateLimit-Reset-Hourly': rateLimitResult.resetTimes.hourly.toISOString(),
        'X-RateLimit-Reset-Daily': rateLimitResult.resetTimes.daily.toISOString(),
        'X-RateLimit-User-Tier': rateLimitResult.tier
      });

      if (!rateLimitResult.allowed) {
        // Check if this is a quality gate failure (all limits are 0 but reset time is far in future)
        const isQualityGate = 
          rateLimitResult.remaining.hourly === 0 && 
          rateLimitResult.remaining.daily === 0 &&
          rateLimitResult.resetTimes.daily > new Date(Date.now() + 2 * 60 * 60 * 1000); // More than 2 hours away

        const isCooldown = 
          rateLimitResult.remaining.hourly === 0 && 
          rateLimitResult.remaining.daily === 0 &&
          rateLimitResult.resetTimes.daily.getTime() === rateLimitResult.resetTimes.hourly.getTime();

        let errorMessage: string;
        let errorType: string;

        if (isQualityGate) {
          errorMessage = 'Quality gate not met: You must have at least 1 post in your most recent ring before creating another fork.';
          errorType = 'quality_gate';
        } else if (isCooldown) {
          errorMessage = `Account is in cooldown period until ${rateLimitResult.resetTimes.daily.toLocaleString()} due to rate limit violations.`;
          errorType = 'cooldown';
        } else {
          // Regular rate limit
          let limitType = 'daily';
          let resetTime = rateLimitResult.resetTimes.daily;
          
          if (rateLimitResult.remaining.hourly === 0) {
            limitType = 'hourly';
            resetTime = rateLimitResult.resetTimes.hourly;
          }

          errorMessage = `Fork rate limit exceeded. You can create ${
            limitType === 'hourly' ? 'another fork in' : 'more forks after'
          } ${resetTime.toLocaleString()}`;
          errorType = 'rate_limit';
        }

        reply.code(429).send({
          error: 'Rate limit exceeded',
          message: errorMessage,
          details: {
            action: options.action,
            errorType,
            resetTime: rateLimitResult.resetTimes.daily.toISOString(),
            tier: rateLimitResult.tier,
            remaining: rateLimitResult.remaining
          }
        });
        return;
      }

      // Store rate limit result for use in route handler
      (request as any).rateLimitResult = rateLimitResult;

    } catch (error) {
      logger.error({ 
        error: {
          message: error?.message || 'Unknown error',
          stack: error?.stack || 'No stack trace',
          name: error?.name || 'Unknown error type',
          cause: error?.cause || 'No cause'
        }, 
        actorDid, 
        action: options.action 
      }, 'Rate limiting check failed');
      
      // On rate limiting service failure, allow the request through
      // but log the error for monitoring
      logger.warn({ actorDid, action: options.action }, 'Rate limiting bypassed due to service error');
    }
  };
}

/**
 * Record rate limit usage after successful action
 */
export async function recordRateLimitUsage(
  request: FastifyRequest, 
  action: string, 
  metadata?: any
): Promise<void> {
  if (!request.actor?.did) {
    return;
  }

  try {
    switch (action) {
      case 'fork_ring':
        await RateLimitingService.recordFork(request.actor.did, metadata?.ringId);
        break;
      default:
        logger.warn({ action }, 'Unknown rate limit action for recording usage');
    }
  } catch (error) {
    logger.error({ error, action, actorDid: request.actor.did }, 'Failed to record rate limit usage');
    // Don't throw - recording failures shouldn't break the main flow
  }
}