// src/queue/queueOps.js
// Small synchronous queue helpers shared by the command handlers

/**
 * Counts queued songs that count toward MAX_SONGS_PER_QUEUE. Local mapping-folder
 * files (isLocalFile) are exempt — they need no download and use negligible memory,
 * so they neither hit the limit nor consume slots for remote/cached tracks.
 * @param {object} queue - Guild queue
 * @returns {number} Number of non-local (downloadable) songs in the queue
 */
function remoteSongCount(queue) {
    return queue.songs.reduce((n, s) => n + (s.isLocalFile ? 0 : 1), 0);
}

/**
 * Stores the queue volume and applies it to the currently playing resource
 * (Stability Pack 4.0 PCM resource with inline volume).
 * @param {object} queue - Guild queue
 * @param {number} volume - 0-100
 */
function setQueueVolume(queue, volume) {
    queue.volume = volume;
    try {
        const res = queue.currentResource; // Use our tracked PCM resource
        if (res && res.volume) res.volume.setVolume(volume / 100);
    } catch { }
}

/**
 * Toggles persistent shuffle mode. While active, each next track is picked at
 * random from the queue (no repeats); the pick itself happens in QueueManager.
 * @param {object} queue - Guild queue
 */
function toggleShuffle(queue) {
    queue.shuffle = !queue.shuffle;
    queue._nextPrepared = false; // re-pick the next track under the new mode
}

module.exports = {
    remoteSongCount,
    setQueueVolume,
    toggleShuffle
};
