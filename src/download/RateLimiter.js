// src/download/RateLimiter.js
// Rate limiting for downloads

const { MAX_DOWNLOADS_PER_USER, RATE_LIMIT_WINDOW_MS } = require('../config/constants');

/**
 * Rate limiter for download requests
 */
class RateLimiter {
    constructor(maxDownloads = MAX_DOWNLOADS_PER_USER, windowMs = RATE_LIMIT_WINDOW_MS) {
        this.limiter = new Map(); // userId -> { count, resetTime }
        this.maxDownloads = maxDownloads;
        this.windowMs = windowMs;

        // Cleanup interval (every 5 minutes)
        setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
    }

    /**
     * Checks if user is within rate limit
     * @param {string} userId - User ID
     * @returns {boolean} True if within limit
     */
    check(userId) {
        const now = Date.now();
        const userLimit = this.limiter.get(userId);

        if (!userLimit || now > userLimit.resetTime) {
            this.limiter.set(userId, { count: 1, resetTime: now + this.windowMs });
            return true;
        }

        if (userLimit.count >= this.maxDownloads) {
            return false;
        }

        userLimit.count++;
        return true;
    }

    /**
     * Cleans up expired entries
     */
    cleanup() {
        const now = Date.now();
        for (const [userId, limit] of this.limiter.entries()) {
            if (now > limit.resetTime) {
                this.limiter.delete(userId);
            }
        }
    }

    /**
     * Gets stats
     * @returns {object} Stats
     */
    getStats() {
        return {
            activeUsers: this.limiter.size,
            maxDownloads: this.maxDownloads,
            windowMs: this.windowMs
        };
    }

    /**
     * Resets limit for user
     * @param {string} userId - User ID
     */
    reset(userId) {
        this.limiter.delete(userId);
    }

    /**
     * Clears all limits
     */
    clear() {
        this.limiter.clear();
    }
}

module.exports = RateLimiter;
