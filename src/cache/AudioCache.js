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
        this.inUseChecker = () => false; // Overridden via setInUseChecker()
        this.ensureDir(downloadDir);
        this.load();
        // Fire-and-forget: remove orphaned files not referenced by the index
        this.reconcileOrphans().catch(e => logger.warn(`[CACHE] Orphan cleanup failed: ${e.message}`));
    }

    /**
     * Sets the checker used to protect files that are still referenced
     * (e.g. by a guild queue) from being deleted by eviction/overwrite.
     * @param {Function} fn - (filepath) => boolean, true if file is in use
     */
    setInUseChecker(fn) {
        this.inUseChecker = typeof fn === 'function' ? fn : (() => false);
    }

    /**
     * Checks whether a filepath is currently in use (best-effort)
     * @param {string} filepath - Path to check
     * @returns {boolean} True if file is in use
     */
    isInUse(filepath) {
        try {
            return !!this.inUseChecker(filepath);
        } catch {
            return false;
        }
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
            // A corrupt index must not make every cached file look orphaned
            this.loadFailed = true;
        }
    }

    /**
     * Scans the download directory and deletes files that are not referenced
     * by the index and are older than 1 hour (mtime). The age threshold
     * protects downloads that are currently in progress. Best-effort:
     * errors are logged but never thrown.
     */
    async reconcileOrphans() {
        const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour
        // Only ever touch the bot's own download files — the download dir is a
        // host bind mount and may contain unrelated user files.
        const OWN_FILE_PATTERN = /^song_\d+_[0-9a-f]{8}\./i;
        if (this.loadFailed) {
            logger.warn('[CACHE] Skipping orphan cleanup: index failed to load');
            return;
        }
        try {
            const referenced = new Set();
            for (const entry of this.cache.values()) {
                if (entry.filepath) referenced.add(path.resolve(entry.filepath));
            }
            const indexPath = path.resolve(this.indexFile);

            const names = await fs.promises.readdir(this.downloadDir);
            const now = Date.now();
            let deleted = 0;
            for (const name of names) {
                if (!OWN_FILE_PATTERN.test(name)) continue;
                const full = path.resolve(this.downloadDir, name);
                if (full === indexPath) continue; // Never delete the index itself
                if (referenced.has(full)) continue;
                try {
                    const stat = await fs.promises.stat(full);
                    if (!stat.isFile()) continue;
                    if (now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue; // Possibly a running download
                    await fs.promises.unlink(full);
                    deleted++;
                } catch { /* ignore individual file errors */ }
            }
            if (deleted > 0) {
                logger.info(`[CACHE] Orphan cleanup: deleted ${deleted} unreferenced file(s)`);
            }
        } catch (e) {
            logger.warn(`[CACHE] Orphan scan failed: ${e.message}`);
        }
    }

    /**
     * Writes cache index to disk immediately.
     */
    async writeIndex() {
        const tempFile = `${this.indexFile}.tmp`;
        await fs.promises.writeFile(tempFile, JSON.stringify([...this.cache], null, 2), "utf-8");
        await fs.promises.rename(tempFile, this.indexFile);
    }

    /**
     * Saves cache index to disk (debounced).
     */
    save() {
        // Keep an already-armed timer: resetting it on every call would postpone
        // the write indefinitely under sustained activity (max 60s latency instead).
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(async () => {
            try {
                this.saveTimer = null;
                await this.writeIndex();
            } catch (e) {
                logger.error(`[CACHE] Async save failed: ${e.message}`);
            }
        }, 60000).unref(); // Debounce 60 seconds to reduce disk I/O
    }

    /**
     * Flushes pending cache changes immediately.
     */
    async flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.writeIndex();
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
        // LRU: refresh timestamp on hit
        e.ts = Date.now();
        this.save();
        return true;
    }

    /**
     * Gets cached filepath for URL
     * @param {string} url - Media URL
     * @returns {string|null} Filepath or null
     */
    get(url) {
        const key = this.makeKeyFromUrl(url);
        const e = this.cache.get(key);
        if (!e) return null;
        // LRU: refresh timestamp on hit
        e.ts = Date.now();
        this.save();
        return e.filepath || null;
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

        // Overwrite: remove the previous file so it does not stay orphaned on disk
        const existing = this.cache.get(key);
        if (existing?.filepath && existing.filepath !== filepath && !this.isInUse(existing.filepath)) {
            fs.promises.unlink(existing.filepath).catch(() => { });
        }

        this.cache.set(key, {
            filepath,
            filename: path.basename(filepath),
            ts: Date.now(),
            meta
        });

        // LRU eviction (oldest first, skipping files that are still in use)
        if (this.cache.size > this.maxEntries) {
            const sorted = [...this.cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
            const toRemove = Math.ceil(this.maxEntries * 0.2);
            let removed = 0;
            for (const [k, v] of sorted) {
                if (removed >= toRemove) break;
                if (k === key) continue; // Never evict the entry just added
                if (v.filepath && this.isInUse(v.filepath)) continue; // Still referenced (e.g. guild queue)
                // Async unlink, ignore errors
                if (v.filepath) {
                    fs.promises.unlink(v.filepath).catch(() => { });
                }
                this.cache.delete(k);
                removed++;
            }
            if (removed < toRemove) {
                logger.warn(`[CACHE] Eviction incomplete: ${removed}/${toRemove} removed, remaining candidates are in use (size=${this.cache.size})`);
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
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

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
