// src/library/LocalMusicLibrary.js
// Index of the local music library (LOCAL_MUSIC_DIR): every subfolder that
// contains audio files, for /playlocalmusic and its autocomplete.

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { LOCAL_AUDIO_EXTENSIONS, LOCAL_MUSIC_INDEX_TTL_MS } = require('../config/constants');
const logger = require('../utils/logger');

// Discord limits for autocomplete choices
const MAX_CHOICES = 25;
const MAX_CHOICE_LENGTH = 100;

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Case-, accent- and Unicode-normalization-insensitive form used for matching,
 * so "banger" finds "Bänger" (precomposed or decomposed).
 * @param {string} text - Text to fold
 * @returns {string} Folded text
 */
function foldForSearch(text) {
    return String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function isAudioFile(name) {
    return LOCAL_AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

// Hidden folders (.Trash-1000 and the like) are never part of the library
function isHiddenName(name) {
    return name.startsWith('.');
}

/**
 * Recursively collects all audio files below baseDir (symlinks and hidden
 * folders are skipped), sorted naturally by their path relative to baseDir.
 * @param {string} baseDir - Folder to collect from
 * @returns {Promise<Array<string>>} Absolute file paths
 */
async function collectLocalAudioFiles(baseDir) {
    const files = [];

    async function walk(dir) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!isHiddenName(entry.name)) await walk(fullPath);
                continue;
            }

            if (entry.isFile() && isAudioFile(entry.name)) {
                files.push(fullPath);
            }
        }
    }

    await walk(baseDir);
    return files.sort((a, b) => naturalCompare(path.relative(baseDir, a), path.relative(baseDir, b)));
}

/**
 * Autocomplete value for a folder: its relative path, or a stable hash when
 * the path exceeds Discord's 100-character value limit.
 */
function folderKey(relPath) {
    if (relPath.length <= MAX_CHOICE_LENGTH) return relPath;
    return '#' + createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

/**
 * Walks the library and returns every non-hidden subfolder that contains
 * audio files (directly or below), sorted naturally by relative path.
 * Unreadable subfolders are skipped; an unreadable root throws.
 * @param {string} rootDir - Library root
 * @returns {Promise<Array<object>>} Folder entries
 */
async function scanFolders(rootDir) {
    const folders = [];

    // Returns the number of audio files in dir and below
    async function walk(dir, segments) {
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (segments.length === 0) throw err;
            logger.debug(`[LOCAL MUSIC] Skipping unreadable folder ${segments.join('/')}: ${err.message}`);
            return 0;
        }

        let count = 0;
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!isHiddenName(entry.name)) count += await walk(path.join(dir, entry.name), [...segments, entry.name]);
            } else if (entry.isFile() && isAudioFile(entry.name)) {
                count++;
            }
        }

        if (segments.length > 0 && count > 0) {
            const relPath = segments.join('/');
            const name = segments[segments.length - 1];
            folders.push({
                relPath,
                name,
                absPath: dir,
                depth: segments.length,
                audioCount: count,
                key: folderKey(relPath),
                searchPath: foldForSearch(relPath),
                searchName: foldForSearch(name)
            });
        }
        return count;
    }

    await walk(rootDir, []);
    return folders.sort((a, b) => naturalCompare(a.relPath, b.relPath));
}

/**
 * Folders matching a query, best first: folder name starts with the query,
 * then folder name contains it, then the full path contains it. Without a
 * query, top-level folders come first. Ties: shallower first, then natural order.
 */
function rankFolders(folders, query) {
    const q = foldForSearch(query || '').replace(/\\/g, '/').trim();
    const ranked = [];
    for (const folder of folders) {
        let score;
        if (!q) score = folder.depth === 1 ? 0 : 1;
        else if (folder.searchName.startsWith(q)) score = 0;
        else if (folder.searchName.includes(q)) score = 1;
        else if (folder.searchPath.includes(q)) score = 2;
        else continue;
        ranked.push({ folder, score });
    }
    ranked.sort((a, b) => a.score - b.score || a.folder.depth - b.folder.depth || naturalCompare(a.folder.relPath, b.folder.relPath));
    return ranked.map(r => r.folder);
}

/**
 * Shortens text to at most max UTF-16 units by cutting at the front (the end
 * of a path is the most specific part), never splitting a surrogate pair.
 */
function keepEnd(text, max) {
    if (text.length <= max) return text;
    const chars = Array.from(text);
    let out = '';
    for (let i = chars.length - 1; i >= 0; i--) {
        if (out.length + chars[i].length + 1 > max) break; // +1 for the ellipsis
        out = chars[i] + out;
    }
    return '…' + out;
}

function toChoice(folder) {
    const suffix = ` (${folder.audioCount})`;
    return { name: keepEnd(folder.relPath, MAX_CHOICE_LENGTH - suffix.length) + suffix, value: folder.key };
}

/**
 * Maps a choice value or typed text to an indexed folder: exact key or path
 * first, then a case/accent-insensitive path match, then the shallowest folder
 * with that name.
 */
function findFolder(folders, value) {
    if (typeof value !== 'string' || !value) return null;
    const exact = folders.find(f => f.key === value || f.relPath === value);
    if (exact) return exact;

    const wanted = foldForSearch(value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim());
    if (!wanted) return null;
    const byPath = folders.find(f => f.searchPath === wanted);
    if (byPath) return byPath;
    const byName = folders.filter(f => f.searchName === wanted).sort((a, b) => a.depth - b.depth);
    return byName[0] || null;
}

class LocalMusicLibrary {
    /**
     * @param {string} rootDir - Library root (read-only mount)
     * @param {object} [options]
     * @param {number} [options.ttlMs] - Rescan the folder index once it is older than this
     */
    constructor(rootDir, { ttlMs = LOCAL_MUSIC_INDEX_TTL_MS } = {}) {
        this.rootDir = path.resolve(rootDir);
        this.ttlMs = ttlMs;
        this.folders = null; // last successful index
        this.indexedAt = 0;
        this.scanning = null; // in-flight scan, shared by concurrent callers
    }

    /**
     * Rescans the library (one scan at a time; concurrent callers share it).
     * @returns {Promise<Array<object>>} Folder entries
     */
    refresh() {
        if (!this.scanning) {
            const started = Date.now();
            this.scanning = scanFolders(this.rootDir)
                .then((folders) => {
                    this.folders = folders;
                    this.indexedAt = Date.now();
                    logger.info(`[LOCAL MUSIC] Indexed ${folders.length} folders in ${Date.now() - started} ms`);
                    return folders;
                })
                .finally(() => { this.scanning = null; });
        }
        return this.scanning;
    }

    /**
     * Current folder index. Scans on first use; once the index is older than
     * the TTL it is still returned right away while a rescan runs in the background.
     * @returns {Promise<Array<object>>} Folder entries
     */
    async getFolders() {
        if (!this.folders) return this.refresh();
        if (Date.now() - this.indexedAt > this.ttlMs) {
            this.refresh().catch(err => logger.warn(`[LOCAL MUSIC] Rescan failed: ${err.message}`));
        }
        return this.folders;
    }

    /**
     * Autocomplete choices (max 25) for what the user typed so far.
     * @param {string} query - Partial folder name or path
     * @param {object} [options]
     * @param {number} [options.maxWaitMs] - Max wait for a first scan (Discord allows ~3 s)
     * @returns {Promise<Array<{name: string, value: string}>>} Choices
     */
    async autocomplete(query, { maxWaitMs = 2000 } = {}) {
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), maxWaitMs); });
        const folders = await Promise.race([this.getFolders(), timeout]).finally(() => clearTimeout(timer));
        if (!folders) return [];
        return rankFolders(folders, query).slice(0, MAX_CHOICES).map(toChoice);
    }

    /**
     * Maps an autocomplete value (or typed text) to an indexed folder. User
     * input only ever selects a folder the scan found — it never becomes a
     * path itself, so "../" and absolute paths cannot escape the library.
     * Rescans once on a miss, so freshly added folders are found.
     * @param {string} value - Choice value or typed folder name
     * @returns {Promise<object|null>} Folder entry or null
     */
    async resolve(value) {
        const folder = findFolder(await this.getFolders(), value);
        if (folder) return folder;
        return findFolder(await this.refresh(), value);
    }
}

module.exports = {
    LocalMusicLibrary,
    collectLocalAudioFiles
};
