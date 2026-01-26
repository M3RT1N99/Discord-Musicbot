// src/download/ytdlp.js
// yt-dlp wrapper functions

const { spawn } = require('child_process');
const { YTDLP_BIN, DOWNLOAD_TIMEOUT_MS, SEARCH_TIMEOUT_MS, DOWNLOAD_DIR } = require('../config/constants');
const { isValidMediaUrl, validateSearchQuery, sanitizeString } = require('../utils/validation');
const { isYouTubePlaylistUrl, cleanPlaylistUrl } = require('../utils/urlCleaner');
const { formatDuration } = require('../utils/formatting');
const fs = require('fs');
const path = require('path');

/**
 * Spawns yt-dlp process with security measures
 * @param {Array<string>} args - Command arguments
 * @param {object} opts - Spawn options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} errorMsg - Error message on timeout
 * @returns {Promise<object>} { stdout, stderr, code }
 */
function spawnYtdlp(args, opts = {}, timeoutMs = DOWNLOAD_TIMEOUT_MS, errorMsg = "yt-dlp timeout") {
    return new Promise((resolve, reject) => {
        // Validate all arguments
        const safeArgs = args.filter(arg => {
            if (typeof arg !== 'string') return false;
            // Prevent dangerous flags
            if (arg.startsWith('--exec') || arg.startsWith('--command')) return false;
            if (arg.includes('..') || arg.includes('\x00')) return false;
            return true;
        });

        const proc = spawn(YTDLP_BIN, safeArgs, {
            ...opts,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false // Prevent shell injection
        });

        let stdout = "", stderr = "";
        proc.stdout.on("data", d => { stdout += d.toString(); });
        proc.stderr.on("data", d => { stderr += d.toString(); });

        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error(errorMsg));
        }, timeoutMs);

        proc.on("error", err => {
            clearTimeout(timer);
            reject(err);
        });

        proc.on("close", code => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr, code });
            else reject(new Error(`yt-dlp exited ${code}: ${stderr.split("\n").slice(-6).join("\n")}`));
        });
    });
}

/**
 * Wrapper for search operations with shorter timeout
 * @param {Array<string>} args - Command arguments
 * @param {object} opts - Spawn options
 * @returns {Promise<object>} { stdout, stderr, code }
 */
function spawnYtdlpSearch(args, opts = {}) {
    return spawnYtdlp(args, opts, SEARCH_TIMEOUT_MS, "Search timeout - try a more specific query");
}

/**
 * Gets info JSON for URL or search query
 * @param {string} urlOrQuery - URL or ytsearch1: query
 * @returns {Promise<object>} Video/playlist info
 */
async function getYtdlpInfo(urlOrQuery) {
    // Validate input
    if (typeof urlOrQuery !== 'string') {
        throw new Error('Invalid input: must be string');
    }

    // For URLs: strict validation
    if (urlOrQuery.startsWith('http')) {
        if (!isValidMediaUrl(urlOrQuery)) {
            throw new Error('Invalid or unsafe URL');
        }
    }
    // For search queries: validate ytsearch1: prefix
    else if (urlOrQuery.startsWith('ytsearch1:')) {
        const query = urlOrQuery.substring(10);
        if (!validateSearchQuery(query)) {
            throw new Error('Invalid search query');
        }
    }
    else {
        throw new Error('Input must be valid URL or ytsearch1: query');
    }

    const args = ["-J", "--no-warnings", "--ignore-errors", "--socket-timeout", "60", urlOrQuery];
    const { stdout } = await spawnYtdlp(args);
    return JSON.parse(stdout);
}

/**
 * Gets playlist entries with metadata
 * @param {string} playlistUrl - Playlist URL
 * @returns {Promise<object>} { playlistTitle, entries }
 */
async function getPlaylistEntries(playlistUrl) {
    // Clean URL first
    playlistUrl = cleanPlaylistUrl(playlistUrl);

    // Validate playlist URL
    if (!isYouTubePlaylistUrl(playlistUrl)) {
        throw new Error('Invalid playlist URL');
    }

    const args = [
        "-J",
        "--no-warnings",
        "--flat-playlist",
        "--playlist-end", "100", // Limit to prevent massive JSON & IO errors
        "--socket-timeout", "60",
        "--ignore-errors",
        "--extractor-args", "youtube:player_client=default",
        playlistUrl
    ];

    let stdout;
    try {
        const res = await spawnYtdlp(args);
        stdout = res.stdout;
    } catch (e) {
        // If yt-dlp errors but returned JSON, try to parse anyway
        if (e.stdout && e.stdout.trim().length > 0) {
            console.warn(`[PLAYLIST WARN] yt-dlp exited with ${e.code}, but returned data. Attempting parse.`);
            stdout = e.stdout;
        } else {
            throw e;
        }
    }

    let json;
    try {
        json = JSON.parse(stdout);
    } catch (e) {
        throw new Error(`Failed to parse playlist JSON: ${e.message}`);
    }

    const playlistTitle = sanitizeString(json.title || json.playlist_title || "Playlist");
    const entriesRaw = json.entries || [];

    // Filter: only valid URLs and safe data
    const entries = entriesRaw
        .map(e => {
            let url = e.url || e.webpage_url;
            // If URL invalid (e.g., only ID), try to construct from ID
            if (!url || !isValidMediaUrl(url)) {
                if (e.id) {
                    url = `https://www.youtube.com/watch?v=${e.id}`;
                } else if (url && !url.includes('/') && url.length > 5) {
                    // Fallback: If url is not a URL but looks like an ID
                    url = `https://www.youtube.com/watch?v=${url}`;
                }
            }
            return {
                url: url,
                title: sanitizeString(e.title || e.id || "Unbekannt"),
                duration: e.duration || null,
                thumbnail: (e.thumbnails && e.thumbnails.length) ? e.thumbnails[e.thumbnails.length - 1].url : null
            };
        })
        .filter(e => e.url && isValidMediaUrl(e.url))
        .slice(0, 100); // Limit playlist size

    return { playlistTitle, entries };
}

/**
 * Gets video info (title, duration, url)
 * @param {string} urlOrId - Video URL or ID
 * @returns {Promise<object>} { title, duration, url }
 */
async function getVideoInfo(urlOrId) {
    // Validate URL
    if (!isValidMediaUrl(urlOrId)) {
        throw new Error('Invalid or unsafe URL');
    }

    const args = ["-J", "--no-warnings", "--ignore-errors", urlOrId];
    console.log(`[VIDEO INFO] Getting info for: ${urlOrId}`);
    const start = Date.now();

    try {
        const { stdout } = await spawnYtdlpSearch(args); // Use short timeout for info query
        const elapsed = Date.now() - start;
        console.log(`[VIDEO INFO] Success in ${elapsed}ms`);

        const info = JSON.parse(stdout);
        return {
            title: sanitizeString(info.title || "Unbekannt"),
            duration: info.duration ? formatDuration(info.duration) : "unbekannt",
            url: info.webpage_url || info.url
        };
    } catch (err) {
        const elapsed = Date.now() - start;
        console.error(`[VIDEO INFO] Failed after ${elapsed}ms:`, err.message);
        throw err;
    }
}

/**
 * Searches for videos on supported platforms
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results (default 10)
 * @param {string} platform - Platform to search (youtube, soundcloud, etc.)
 * @returns {Promise<Array>} Search results
 */
async function searchVideos(query, maxResults = 10, platform = 'youtube') {
    if (!validateSearchQuery(query)) {
        throw new Error('Invalid search query');
    }

    let searchQuery;
    switch (platform.toLowerCase()) {
        case 'youtube':
            searchQuery = `ytsearch${maxResults}:${query}`;
            break;
        case 'soundcloud':
            searchQuery = `scsearch${maxResults}:${query}`;
            break;
        default:
            // General search (primarily YouTube)
            searchQuery = `ytsearch${maxResults}:${query}`;
    }

    const args = [
        "-J",
        "--no-warnings",
        "--flat-playlist",
        searchQuery
    ];

    const { stdout } = await spawnYtdlpSearch(args);
    const info = JSON.parse(stdout);

    if (!info.entries || !Array.isArray(info.entries)) {
        return [];
    }

    return info.entries
        .filter(entry => entry.url && entry.title)
        .slice(0, maxResults)
        .map((entry, index) => ({
            index: index + 1,
            url: entry.url,
            title: sanitizeString(entry.title || "Unbekannt"),
            uploader: sanitizeString(entry.uploader || entry.channel || "Unbekannt"),
            duration: entry.duration ? formatDuration(entry.duration) : "unbekannt"
        }));
}

/**
 * YouTube-specific search (alias for searchVideos)
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results
 * @returns {Promise<Array>} Search results
 */
async function searchYouTubeVideos(query, maxResults = 10) {
    return searchVideos(query, maxResults, 'youtube');
}

/**
 * Downloads single video to filepath with progress callback
 * @param {string} filepath - Destination filepath
 * @param {string} urlOrId - Video URL or ID
 * @param {Function} progressCb - Progress callback
 * @returns {Promise<object>} { filepath, stderr }
 */
function downloadSingleTo(filepath, urlOrId, progressCb) {
    return new Promise((resolve, reject) => {
        // Validate URL
        if (!isValidMediaUrl(urlOrId)) {
            return reject(new Error('Invalid or unsafe URL for download'));
        }

        // Validate filepath
        if (!filepath || typeof filepath !== 'string') {
            return reject(new Error('Invalid filepath'));
        }

        const normalizedPath = path.normalize(filepath);
        const normalizedDownloadDir = path.normalize(DOWNLOAD_DIR);
        if (!normalizedPath.startsWith(normalizedDownloadDir)) {
            return reject(new Error('Filepath outside allowed directory'));
        }

        // Ensure directory exists
        if (!fs.existsSync(DOWNLOAD_DIR)) {
            fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        }

        const args = [
            "-f", "bestaudio",
            "--extract-audio",
            "--audio-format", "m4a",
            "--audio-quality", "320K",
            "--socket-timeout", "60",
            "--retries", "3",
            "--no-warnings",
            "--no-playlist",
            "--ignore-errors",
            "--newline", // Important for line-by-line output
            "-o", filepath,
            urlOrId
        ];

        const proc = spawn(YTDLP_BIN, args, { shell: false });
        let stderr = "";

        // Performance optimization: Reduced logging and direct buffering
        proc.stdout.on("data", d => {
            const line = d.toString().trim();

            // Only log non-progress lines or errors to reduce I/O
            if (!line.includes('[download]') || line.includes('error')) {
                console.log("yt-dlp:", line);
            }

            if (progressCb) {
                // Use setImmediate to not block event loop with progress updates
                setImmediate(() => {
                    try {
                        progressCb(line);
                    } catch (err) {
                        /* ignore progress callback errors */
                    }
                });
            }
        });

        proc.stderr.on("data", d => {
            stderr += d.toString();
        });

        // Timeout if download hangs
        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error("Download timeout"));
        }, DOWNLOAD_TIMEOUT_MS);

        proc.on("error", err => {
            clearTimeout(timer);
            reject(err);
        });

        proc.on("close", code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(filepath)) {
                resolve({ filepath, stderr });
            } else {
                reject(new Error(`yt-dlp failed (${code}): ${stderr.split("\n").slice(-6).join("\n")}`));
            }
        });
    });
}

module.exports = {
    spawnYtdlp,
    spawnYtdlpSearch,
    getYtdlpInfo,
    getPlaylistEntries,
    getVideoInfo,
    searchVideos,
    searchYouTubeVideos,
    downloadSingleTo
};
