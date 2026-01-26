// src/utils/formatting.js
// Text and data formatting utilities

/**
 * Formats duration in seconds to human-readable string
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration (h:mm:ss or m:ss)
 */
function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return "unbekannt";
    seconds = Math.floor(Number(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Truncates message to maximum length
 * @param {string} msg - Message to truncate
 * @param {number} maxLen - Maximum length (default 1950)
 * @returns {string} Truncated message
 */
function truncateMessage(msg, maxLen = 1950) {
    if (typeof msg !== "string") msg = String(msg);
    return msg.length > maxLen ? msg.substring(0, maxLen - 3) + "..." : msg;
}

/**
 * Shuffles array in place (Fisher-Yates shuffle)
 * @param {Array} a - Array to shuffle
 * @returns {Array} Shuffled array
 */
function shuffleArray(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

module.exports = {
    formatDuration,
    truncateMessage,
    shuffleArray
};
