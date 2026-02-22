// src/cache/AudioCache.js
// Audio file caching system with LRU eviction

const fs = require('fs');
const path = require('path');
const { MAX_CACHE } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * Audio Cache with LRU eviction
 * Manages downloaded audio files with persistence
 */
class AudioCache {
    /**
     * @param {number} maxEntries - Maximum number of cached entries
     * @param {string} downloadDir - Directory for downloads and index file
     */
    constructor(maxEntries = MAX_CACHE, downloadDir) {
        this.maxEntries = maxEntries;
        this.downloadDir = downloadDir;
        this.indexFile = path.join(downloadDir, ".cache_index.json");
        this.cache = new Map(); // key -> { filepath, filename, ts, meta }
        this.ensureDir(downloadDir);
        this.load();
    }

    /**
     * Ensures directory exists
     * @param {string} dir - Directory path
     */
    ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Loads cache index from disk
     */
    load() {
        try {
            if (fs.existsSync(this.indexFile)) {
                const raw = fs.readFileSync(this.indexFile, "utf-8");
                const arr = JSON.parse(raw);
                this.cache = new Map(arr);
                logger.info(`[CACHE] Loaded ${this.cache.size} entries`);
            }
        } catch (e) {
            logger.warn(`[CACHE] Load failed: ${e.message}`);
            this.cache = new Map();
        }
    }

    /**
     * Saves cache index to disk (debounced)
     */
    save() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(async () => {
            try {
                // Atomic write: temp file then rename
                const tempFile = `${this.indexFile}.tmp`;
                await fs.promises.writeFile(tempFile, JSON.stringify([...this.cache], null, 2), "utf-8");
                await fs.promises.rename(tempFile, this.indexFile);
            } catch (e) {
                logger.error(`[CACHE] Async save failed: ${e.message}`);
            }
        }, 60000).unref(); // Debounce 60 seconds to reduce disk I/O
    }

    /**
     * Creates cache key from URL
     * @param {string} url - Media URL
     * @returns {string} Cache key
     */
    makeKeyFromUrl(url) {
        try {
            const u = new URL(url);
            if (u.hostname.includes("youtu")) {
                if (u.searchParams.has("v")) return u.searchParams.get("v");
                const p = u.pathname.split("/").filter(Boolean);
                if (u.hostname.includes("youtu.be") && p.length) return p[p.length - 1];
            }
        } catch { }
        return url;
    }

    /**
     * Checks if URL is in cache and file exists
     * @param {string} url - Media URL
     * @returns {boolean} True if cached and file exists
     */
    has(url) {
        const key = this.makeKeyFromUrl(url);
        const e = this.cache.get(key);
        if (!e) return false;
        if (!fs.existsSync(e.filepath)) {
            this.cache.delete(key);
            this.save();
            return false;
        }
        return true;
    }

    /**
     * Gets cached filepath for URL
     * @param {string} url - Media URL
     * @returns {string|null} Filepath or null
     */
    get(url) {
        const key = this.makeKeyFromUrl(url);
        return this.cache.get(key)?.filepath || null;
    }

    /**
     * Gets full cache entry for URL
     * @param {string} url - Media URL
     * @returns {object|null} Cache entry or null
     */
    getEntry(url) {
        const key = this.makeKeyFromUrl(url);
        return this.cache.get(key) || null;
    }

    /**
     * Adds file to cache
     * @param {string} url - Media URL
     * @param {string} filepath - Path to cached file
     * @param {object} meta - Metadata (title, duration, etc.)
     */
    set(url, filepath, meta = {}) {
        const key = this.makeKeyFromUrl(url);
        this.cache.set(key, {
            filepath,
            filename: path.basename(filepath),
            ts: Date.now(),
            meta
        });

        // LRU eviction
        if (this.cache.size > this.maxEntries) {
            const sorted = [...this.cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
            const toRemove = Math.ceil(this.maxEntries * 0.2);
            for (let i = 0; i < toRemove; i++) {
                const [k, v] = sorted[i];
                // Async unlink, ignore errors
                if (v.filepath) {
                    fs.promises.unlink(v.filepath).catch(() => { });
                }
                this.cache.delete(k);
            }
        }
        this.save();
    }

    /**
     * Gets cache statistics
     * @returns {object} Cache stats
     */
    getStats() {
        return {
            size: this.cache.size,
            maxEntries: this.maxEntries,
            utilizationPercent: ((this.cache.size / this.maxEntries) * 100).toFixed(2)
        };
    }

    /**
     * Returns all cache entries as [key, value] pairs
     * @returns {Array} Array of [key, entry] pairs
     */
    getAllEntries() {
        return [...this.cache.entries()];
    }

    /**
     * Clears entire cache: deletes all files, the index, and resets the map
     */
    clear() {
        const entries = [...this.cache.values()];
        let deletedFiles = 0;

        for (const entry of entries) {
            try {
                if (entry.filepath && fs.existsSync(entry.filepath)) {
                    fs.unlinkSync(entry.filepath);
                    deletedFiles++;
                }
            } catch (e) {
                logger.warn(`[CACHE CLEAR] Could not delete: ${entry.filepath} - ${e.message}`);
            }
        }

        this.cache.clear();

        // Delete index file
        try {
            if (fs.existsSync(this.indexFile)) fs.unlinkSync(this.indexFile);
        } catch (e) {
            logger.warn(`[CACHE CLEAR] Could not delete index: ${e.message}`);
        }

        logger.info(`[CACHE CLEAR] Removed ${entries.length} entries, deleted ${deletedFiles} files`);
    }
}

module.exports = AudioCache;
