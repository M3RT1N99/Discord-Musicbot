// src/utils/validation.js
// Input validation and security utilities

const { BLOCKED_URL_PATTERNS, MAX_QUERY_LENGTH, MAX_URL_LENGTH } = require('../config/constants');
const logger = require('./logger');

/**
 * Sanitizes string input by removing potentially dangerous characters
 * @param {string} input - Input string to sanitize
 * @returns {string} Sanitized string
 */
function sanitizeString(input) {
    if (typeof input !== 'string') return '';
    // Remove potentially dangerous characters (including newlines to prevent log injection)
    return input.replace(/[<>"|;$`\\\r\n]/g, '').trim();
}

/**
 * Checks if an interaction is still valid (not expired)
 * @param {Interaction} interaction - Discord interaction
 * @returns {boolean} True if interaction is valid
 */
function isInteractionValid(interaction) {
    const interactionAge = Date.now() - interaction.createdTimestamp;
    const maxAge = 15 * 60 * 1000; // 15 Minutes (Discord Limit)
    return interactionAge < maxAge;
}

/**
 * Safe follow-up message sender with timeout checking
 * @param {Interaction} interaction - Discord interaction
 * @param {string|object} content - Message content
 * @param {object} options - Additional options
 * @returns {Promise<Message|null>} Sent message or null
 */
async function safeFollowUp(interaction, content, options = {}) {
    try {
        const interactionAge = Date.now() - interaction.createdTimestamp;
        const canFollowUp = interactionAge < 14 * 60 * 1000; // 14 minutes

        if (!canFollowUp) {
            logger.warn("[FOLLOWUP TIMEOUT] Interaction too old for follow-up");
            return null;
        }

        // If deferred, use editReply for first response
        if (interaction.deferred && !interaction.replied) {
            return await interaction.editReply(typeof content === 'string' ? { content, ...options } : content);
        }

        return await interaction.followUp(typeof content === 'string' ? { content, ...options } : content);
    } catch (error) {
        if (error.code === 10062) {
            logger.warn("[FOLLOWUP EXPIRED] Interaction token expired");
        } else {
            logger.error(`[FOLLOWUP ERROR] ${error}`);
        }
        return null;
    }
}

/**
 * Validates a URL for security
 * @param {string} urlString - URL to validate
 * @returns {boolean} True if URL is valid and safe
 */
function validateUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') return false;
    if (urlString.length > MAX_URL_LENGTH) return false;

    try {
        const url = new URL(urlString);

        // Only allow HTTP/HTTPS
        if (!['http:', 'https:'].includes(url.protocol)) return false;

        // Check for dangerous URL patterns
        const fullUrl = urlString.toLowerCase();
        for (const pattern of BLOCKED_URL_PATTERNS) {
            if (pattern.test(fullUrl)) return false;
        }

        // Check for dangerous characters in URL
        if (/[<>"|;$`\\]/.test(urlString)) return false;

        return true;
    } catch {
        return false;
    }
}

/**
 * Validates a search query for security
 * @param {string} query - Search query to validate
 * @returns {boolean} True if query is valid
 */
function validateSearchQuery(query) {
    if (!query || typeof query !== 'string') return false;
    if (query.length > MAX_QUERY_LENGTH) return false;

    // Prevent command injection attempts
    const dangerousPatterns = [
        /[;&|`$(){}[\]]/,  // Shell metacharacters
        /\.\./,            // Directory traversal
        /^-/,              // Command flags
        /\x00/,            // Null bytes
        /[\r\n]/           // Line breaks
    ];

    return !dangerousPatterns.some(pattern => pattern.test(query));
}

/**
 * General URL validation for all yt-dlp supported sites
 * @param {string} urlString - URL to validate
 * @returns {boolean} True if valid media URL
 */
function isValidMediaUrl(urlString) {
    return validateUrl(urlString);
}

/**
 * YouTube-specific URL validation
 * @param {string} urlString - URL to validate
 * @returns {boolean} True if valid YouTube URL
 */
function isValidYouTubeUrl(urlString) {
    if (!validateUrl(urlString)) return false;

    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();

        // YouTube Video URL patterns
        if (hostname.includes('youtube.com')) {
            return url.searchParams.has('v') || url.pathname.includes('/watch');
        }
        if (hostname === 'youtu.be') {
            return url.pathname.length > 1;
        }
        return false;
    } catch {
        return false;
    }
}

module.exports = {
    sanitizeString,
    isInteractionValid,
    safeFollowUp,
    validateUrl,
    validateSearchQuery,
    isValidMediaUrl,
    isValidYouTubeUrl
};
