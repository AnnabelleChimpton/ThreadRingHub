import { prisma } from '../database/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';

export interface RateLimitConfig {
  hourly: number;
  daily: number;
  weekly: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: {
    hourly: number;
    daily: number;
    weekly: number;
  };
  resetTimes: {
    hourly: Date;
    daily: Date;
    weekly: Date;
  };
  tier: string;
}

export class RateLimitingService {
  // Rate limits by user tier (with burst protection - max 2/hour for all tiers)
  private static readonly FORK_LIMITS: Record<string, RateLimitConfig> = {
    NEW: { hourly: 1, daily: 1, weekly: 3 },
    ESTABLISHED: { hourly: 2, daily: 3, weekly: 15 },
    VETERAN: { hourly: 2, daily: 5, weekly: 25 },  // Capped at 2/hour for burst protection
    TRUSTED: { hourly: 2, daily: 10, weekly: 50 }  // Capped at 2/hour for burst protection
  };

  // Absolute maximum burst limit (applies to all users)
  private static readonly MAX_FORKS_PER_HOUR = 2;

  /**
   * Check if actor can perform fork action with additional safeguards
   */
  static async checkForkLimit(actorDid: string): Promise<RateLimitResult> {
    // Check if user is admin (bypasses all rate limits)
    const isAdmin = await this.isAdmin(actorDid);
    if (isAdmin) {
      return {
        allowed: true,
        remaining: { hourly: 999, daily: 999, weekly: 999 },
        resetTimes: {
          hourly: new Date(Date.now() + 60 * 60 * 1000),
          daily: new Date(Date.now() + 24 * 60 * 60 * 1000),
          weekly: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        },
        tier: 'ADMIN'
      };
    }

    // Check for cooldown period
    const reputation = await prisma.actorReputation.findUnique({
      where: { actorDid }
    });

    if (reputation?.cooldownUntil && reputation.cooldownUntil > new Date()) {
      return {
        allowed: false,
        remaining: { hourly: 0, daily: 0, weekly: 0 },
        resetTimes: {
          hourly: reputation.cooldownUntil,
          daily: reputation.cooldownUntil,
          weekly: reputation.cooldownUntil
        },
        tier: reputation.tier
      };
    }

    // Quality gate check: Users must have at least 1 post in their last created ring before forking again
    const qualityGateCheck = await this.checkQualityGate(actorDid);
    if (!qualityGateCheck.passed) {
      return {
        allowed: false,
        remaining: { hourly: 0, daily: 0, weekly: 0 },
        resetTimes: {
          hourly: new Date(Date.now() + 24 * 60 * 60 * 1000), // Try again tomorrow
          daily: new Date(Date.now() + 24 * 60 * 60 * 1000),
          weekly: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        },
        tier: await this.getUserTier(actorDid)
      };
    }

    const tier = await this.getUserTier(actorDid);
    const limits = this.FORK_LIMITS[tier];
    
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get recent fork attempts
    const [hourlyCount, dailyCount, weeklyCount] = await Promise.all([
      this.getActionCount(actorDid, 'fork_ring', hourAgo),
      this.getActionCount(actorDid, 'fork_ring', dayAgo),
      this.getActionCount(actorDid, 'fork_ring', weekAgo)
    ]);

    const allowed = 
      hourlyCount < limits.hourly && 
      dailyCount < limits.daily && 
      weeklyCount < limits.weekly;

    return {
      allowed,
      remaining: {
        hourly: Math.max(0, limits.hourly - hourlyCount),
        daily: Math.max(0, limits.daily - dailyCount),
        weekly: Math.max(0, limits.weekly - weeklyCount)
      },
      resetTimes: {
        hourly: new Date(hourAgo.getTime() + 60 * 60 * 1000),
        daily: new Date(dayAgo.getTime() + 24 * 60 * 60 * 1000),
        weekly: new Date(weekAgo.getTime() + 7 * 24 * 60 * 60 * 1000)
      },
      tier
    };
  }

  /**
   * Record a fork action and check for review flagging
   */
  static async recordFork(actorDid: string, ringId?: string): Promise<void> {
    // Record the action
    await prisma.rateLimit.create({
      data: {
        actorDid,
        action: 'fork_ring',
        windowType: 'action',
        metadata: ringId ? { ringId } : undefined
      }
    });

    // Check if user should be flagged for review
    await this.checkForReviewFlag(actorDid);
  }

  /**
   * Check if user is admin (bypasses rate limits)
   */
  static async isAdmin(actorDid: string): Promise<boolean> {
    const actor = await prisma.actor.findUnique({
      where: { did: actorDid },
      select: { isAdmin: true }
    });
    
    return actor?.isAdmin || false;
  }

  /**
   * Get user tier based on account age and reputation
   */
  static async getUserTier(actorDid: string): Promise<string> {
    // Try to get cached reputation first
    const reputation = await prisma.actorReputation.findUnique({
      where: { actorDid }
    });

    if (reputation && this.isReputationFresh(reputation.lastCalculatedAt)) {
      return reputation.tier;
    }

    // Calculate fresh tier
    const actor = await prisma.actor.findUnique({
      where: { did: actorDid },
      select: { 
        discoveredAt: true, 
        trusted: true, 
        verified: true 
      }
    });

    if (!actor) {
      return 'NEW';
    }

    const accountAge = Date.now() - actor.discoveredAt.getTime();
    const daysSinceCreated = accountAge / (1000 * 60 * 60 * 24);

    let tier: string;
    if (actor.trusted || (actor.verified && daysSinceCreated > 90)) {
      tier = 'TRUSTED';
    } else if (daysSinceCreated >= 30) {
      tier = 'VETERAN';  
    } else if (daysSinceCreated >= 7) {
      tier = 'ESTABLISHED';
    } else {
      tier = 'NEW';
    }

    // Update/create reputation record
    await this.updateActorReputation(actorDid, tier);

    return tier;
  }

  /**
   * Get count of actions within time window
   */
  private static async getActionCount(
    actorDid: string, 
    action: string, 
    since: Date
  ): Promise<number> {
    return await prisma.rateLimit.count({
      where: {
        actorDid,
        action,
        performedAt: { gte: since }
      }
    });
  }

  /**
   * Check if reputation data is fresh (updated within last hour)
   */
  private static isReputationFresh(lastCalculated: Date): boolean {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return lastCalculated > hourAgo;
  }

  /**
   * Update actor reputation and tier
   */
  private static async updateActorReputation(actorDid: string, tier: string): Promise<void> {
    try {
      // Calculate activity metrics
      const [ringsCreated, membershipCount, totalPosts] = await Promise.all([
        prisma.ring.count({ where: { ownerDid: actorDid } }),
        prisma.membership.count({ 
          where: { actorDid, status: 'ACTIVE' } 
        }),
        prisma.postRef.count({ 
          where: { actorDid, status: 'ACCEPTED' } 
        })
      ]);

      const activeRings = await prisma.ring.count({
        where: {
          ownerDid: actorDid,
          postRefs: {
            some: {
              status: 'ACCEPTED'
            }
          }
        }
      });

      // Simple reputation score calculation
      const reputationScore = 
        (activeRings * 10) + 
        (totalPosts * 2) + 
        (membershipCount * 1);

      await prisma.actorReputation.upsert({
        where: { actorDid },
        update: {
          tier: tier as any,
          reputationScore,
          ringsCreated,
          activeRings,
          totalPosts,
          membershipCount,
          lastCalculatedAt: new Date()
        },
        create: {
          actorDid,
          tier: tier as any,
          reputationScore,
          ringsCreated,
          activeRings,
          totalPosts,
          membershipCount
        }
      });
    } catch (error) {
      logger.error({ error, actorDid }, 'Failed to update actor reputation');
      // Don't throw - reputation updates shouldn't break main flow
    }
  }

  /**
   * Quality gate check: Ensure user has at least 1 post in their most recent ring before allowing another fork
   */
  private static async checkQualityGate(actorDid: string): Promise<{ passed: boolean; reason?: string }> {
    // Get the user's most recently created ring
    const recentRing = await prisma.ring.findFirst({
      where: { ownerDid: actorDid },
      orderBy: { createdAt: 'desc' },
    });

    // If no rings exist, allow fork
    if (!recentRing) {
      return { passed: true };
    }

    // Count non-notification posts
    const realPostCount = await prisma.postRef.count({
      where: {
        ringId: recentRing.id,
        status: 'ACCEPTED',
        NOT: {
          // Only exclude posts that explicitly have type: 'fork_notification'
          metadata: {
            path: ['type'],
            equals: 'fork_notification'
          }
        }
      }
    });

    // If the most recent ring has real posts, allow fork
    if (realPostCount > 0) {
      return { passed: true };
    }

    // Check if the ring is brand new (created within last hour) - give some grace period
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (recentRing.createdAt > hourAgo) {
      return { passed: true };
    }

    return { 
      passed: false, 
      reason: 'Must have at least 1 post in your most recent ring before creating another' 
    };
  }

  /**
   * Check if user should be flagged for human review based on fork volume
   */
  private static async checkForReviewFlag(actorDid: string): Promise<void> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Count forks in the last week and month
    const [weeklyCount, monthlyCount] = await Promise.all([
      this.getActionCount(actorDid, 'fork_ring', weekAgo),
      this.getActionCount(actorDid, 'fork_ring', monthAgo)
    ]);

    // Flag thresholds
    const shouldFlag = 
      weeklyCount >= 20 ||  // 20+ forks in a week
      monthlyCount >= 50;   // 50+ forks in a month

    if (shouldFlag) {
      await prisma.actorReputation.upsert({
        where: { actorDid },
        update: { flaggedForReview: true },
        create: {
          actorDid,
          flaggedForReview: true,
          tier: 'NEW'
        }
      });

      logger.warn({ 
        actorDid, 
        weeklyCount, 
        monthlyCount 
      }, 'User flagged for human review due to high fork volume');
    }
  }

  /**
   * Apply cooldown penalty for violations
   */
  static async applyCooldown(actorDid: string, hours: number = 24): Promise<void> {
    const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000);

    await prisma.actorReputation.upsert({
      where: { actorDid },
      update: {
        violationCount: { increment: 1 },
        lastViolationAt: new Date(),
        cooldownUntil,
        // Escalate cooldown for repeat offenders
        tier: 'NEW' // Demote to most restrictive tier
      },
      create: {
        actorDid,
        tier: 'NEW',
        violationCount: 1,
        lastViolationAt: new Date(),
        cooldownUntil
      }
    });

    logger.warn({ actorDid, cooldownUntil }, 'Applied rate limit cooldown');
  }

  /**
   * Remove flags and reset violation count (admin action)
   */
  static async clearViolations(actorDid: string): Promise<void> {
    await prisma.actorReputation.update({
      where: { actorDid },
      data: {
        flaggedForReview: false,
        violationCount: 0,
        lastViolationAt: null,
        cooldownUntil: null
      }
    });
  }

  /**
   * Get users flagged for review
   */
  static async getFlaggedUsers(): Promise<any[]> {
    return await prisma.actorReputation.findMany({
      where: { flaggedForReview: true },
      include: {
        // Get actor name if available
      },
      orderBy: { lastCalculatedAt: 'desc' }
    });
  }

  /**
   * Clean up old rate limit records (run periodically)
   */
  static async cleanupOldRecords(): Promise<void> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    await prisma.rateLimit.deleteMany({
      where: {
        performedAt: { lt: weekAgo }
      }
    });
  }
}