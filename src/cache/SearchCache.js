// src/cache/SearchCache.js
// Search results caching system

const { SEARCH_CACHE_TIMEOUT } = require('../config/constants');

/**
 * Search results cache with automatic expiration
 */
class SearchCache {
    constructor(timeout = SEARCH_CACHE_TIMEOUT) {
        this.cache = new Map(); // userId -> { results, timestamp, messageId, channelId }
        this.timeout = timeout;

        // Cleanup interval every 5 minutes
        setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
    }

    /**
     * Sets search results for user
     * @param {string} userId - Discord user ID
     * @param {object} data - Cache data
     */
    set(userId, data) {
        this.cache.set(userId, {
            ...data,
            timestamp: data.timestamp || Date.now()
        });

        // Schedule automatic cleanup for this entry
        setTimeout(() => {
            const cached = this.cache.get(userId);
            if (cached && cached.timestamp === data.timestamp) {
                this.cache.delete(userId);
            }
        }, this.timeout + 1000);
    }

    /**
     * Gets search results for user
     * @param {string} userId - Discord user ID
     * @returns {object|null} Cache data or null
     */
    get(userId) {
        const cached = this.cache.get(userId);
        if (!cached) return null;

        // Check if expired
        if (Date.now() - cached.timestamp > this.timeout) {
            this.cache.delete(userId);
            return null;
        }

        return cached;
    }

    /**
     * Checks if user has valid cached results
     * @param {string} userId - Discord user ID
     * @returns {boolean} True if valid cache exists
     */
    has(userId) {
        return this.get(userId) !== null;
    }

    /**
     * Deletes cache entry for user
     * @param {string} userId - Discord user ID
     */
    delete(userId) {
        this.cache.delete(userId);
    }

    /**
     * Cleans up expired entries
     */
    cleanup() {
        const now = Date.now();
        for (const [userId, data] of this.cache.entries()) {
            if (now - data.timestamp > this.timeout) {
                this.cache.delete(userId);
            }
        }
    }

    /**
     * Gets cache statistics
     * @returns {object} Cache stats
     */
    getStats() {
        return {
            size: this.cache.size,
            timeout: this.timeout
        };
    }

    /**
     * Clears all cache entries
     */
    clear() {
        this.cache.clear();
    }
}

module.exports = SearchCache;
