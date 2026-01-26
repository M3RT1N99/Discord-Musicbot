// src/utils/urlCleaner.js
// URL cleaning and manipulation utilities

const { validateUrl } = require('./validation');

/**
 * Checks if string is a URL
 * @param {string} s - String to check
 * @returns {boolean} True if URL
 */
function isUrl(s) {
    return validateUrl(s);
}

/**
 * Checks if URL is a YouTube playlist
 * @param {string} u - URL to check
 * @returns {boolean} True if YouTube playlist URL
 */
function isYouTubePlaylistUrl(u) {
    try {
        if (!validateUrl(u)) return false;
        const url = new URL(u);
        return url.searchParams.has("list");
    } catch {
        return false;
    }
}

/**
 * Extracts clean YouTube URL without parameters
 * @param {string} url - YouTube URL to clean
 * @returns {string|null} Clean URL or null
 */
function cleanYouTubeUrl(url) {
    if (!url) return null;

    // Try to extract video ID
    const patterns = [
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/, // Standard
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,       // /v/VIDEOID
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,   // /embed/VIDEOID
        /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/                        // Short link
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return `https://www.youtube.com/watch?v=${match[1]}`;
        }
    }

    // No valid link found
    return null;
}

/**
 * Cleans playlist URL from potentially harmful/broken parameters
 * @param {string} url - Playlist URL to clean
 * @returns {string|null} Cleaned URL or original
 */
function cleanPlaylistUrl(url) {
    if (!url) return null;

    try {
        const u = new URL(url);
        const listId = u.searchParams.get("list");
        if (!listId) return url;

        // Detect malformed list IDs (e.g., "PLxyz...i=abc...")
        // We take everything until the first non-alphanumeric character (except - and _)
        // Standard YouTube IDs are [a-zA-Z0-9_-]+
        // If "list" contains weird characters, we cut them off

        // Special check for "=" within ID (typical error from copy-paste concatenation)
        if (listId.includes("=")) {
            const cleanId = listId.split("=")[0];

            // Strategy 1: Regex for standard 34-char PL playlists (PL + 32 chars)
            // This is the safest method since we know exactly how long the ID must be
            const plMatch = cleanId.match(/^(PL[a-zA-Z0-9_-]{32})/);
            if (plMatch) {
                u.searchParams.set("list", plMatch[1]);
                return u.toString();
            }

            // If rest looks valid, use it (fallback for other ID types)
            if (/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
                // Some IDs have suffix characters that were accidentally appended
                // Try to clean. Typical case: "&si=..." loses the "&" -> "IDsi=..."
                if (cleanId.length > 30 && cleanId.endsWith('si')) {
                    u.searchParams.set("list", cleanId.slice(0, -2));
                }
                // Fallback for case where only "i" remains
                else if (cleanId.length > 34 && cleanId.endsWith('i')) {
                    u.searchParams.set("list", cleanId.slice(0, -1));
                } else {
                    u.searchParams.set("list", cleanId);
                }
            }
        }

        return u.toString();
    } catch {
        return url;
    }
}

/**
 * Checks if URL is a real playlist (not Auto-Mix/Radio)
 * @param {string} url - URL to check
 * @returns {boolean} True if real playlist
 */
function isRealPlaylist(url) {
    try {
        const urlObj = new URL(url);
        const listParam = urlObj.searchParams.get('list');

        if (!listParam) return false;

        // Auto-Mix/Radio lists (start with RD)
        if (listParam.startsWith('RD')) {
            console.log(`[PLAYLIST CHECK] Auto-Mix/Radio detected: ${listParam}`);
            return true;
        }

        // Real playlists (start with PL or UU)
        if (listParam.startsWith('PL') || listParam.startsWith('UU')) {
            console.log(`[PLAYLIST CHECK] Real playlist detected: ${listParam}`);
            return true;
        }

        // Other playlist types treated as real
        console.log(`[PLAYLIST CHECK] Other playlist type: ${listParam}`);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    isUrl,
    isYouTubePlaylistUrl,
    cleanYouTubeUrl,
    cleanPlaylistUrl,
    isRealPlaylist
};
