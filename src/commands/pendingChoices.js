// src/commands/pendingChoices.js
// Pending "song or playlist?" choices for URLs that contain both

const { randomUUID } = require('crypto');
const { MAX_PENDING_CHOICES } = require('../config/constants');

// Pending playlist/song choices (short key -> { url, userId, createdAt })
const pendingPlaylistChoices = new Map();

// Cleanup expired playlist choices every 2 minutes (prevent memory leak)
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingPlaylistChoices) {
        if (now - (val.createdAt || 0) > 60000) {
            pendingPlaylistChoices.delete(key);
        }
    }
}, 120000).unref();

/**
 * Stores a choice under a new short key (customId max 100 chars),
 * evicting the oldest pending choice at capacity.
 * @param {string} url - URL the user asked for
 * @param {string} userId - Only this user may answer
 * @returns {string} Choice key for the button customIds
 */
function createPendingChoice(url, userId) {
    const choiceKey = randomUUID().slice(0, 8);

    // Evict oldest if at capacity
    if (pendingPlaylistChoices.size >= MAX_PENDING_CHOICES) {
        const oldestKey = pendingPlaylistChoices.keys().next().value;
        pendingPlaylistChoices.delete(oldestKey);
    }

    pendingPlaylistChoices.set(choiceKey, { url, userId, createdAt: Date.now() });
    return choiceKey;
}

/**
 * @param {string} choiceKey - Choice key
 * @returns {object|undefined} { url, userId, createdAt } while still pending
 */
function getPendingChoice(choiceKey) {
    return pendingPlaylistChoices.get(choiceKey);
}

/**
 * Consumes a choice.
 * @param {string} choiceKey - Choice key
 * @returns {boolean} true if it was still pending
 */
function deletePendingChoice(choiceKey) {
    return pendingPlaylistChoices.delete(choiceKey);
}

module.exports = {
    createPendingChoice,
    getPendingChoice,
    deletePendingChoice
};
