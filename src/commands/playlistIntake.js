// src/commands/playlistIntake.js
// Loads a playlist into the queue: the first entry plays right away,
// the rest is queued for background download

const { MAX_SONGS_PER_QUEUE } = require('../config/constants');
const { getPlaylistEntries } = require('../download/ytdlp');
const { ensureNextTrackDownloadedAndPlay } = require('../queue/QueueManager');
const { remoteSongCount } = require('../queue/queueOps');
const { safeFollowUp } = require('../utils/validation');
const { handleSingleUrlPlay } = require('./singleTrack');
const ui = require('../ui/messages');
const logger = require('../utils/logger');

/**
 * Fetches a playlist and fills the (already joined) guild queue with it.
 * Errors from the playlist fetch are reported to the user; anything else
 * propagates to the caller.
 * @param {object} context - Handler context
 * @param {object} queue - Guild queue
 * @param {string} url - Playlist URL (an index parameter picks the start entry)
 * @param {object} options
 * @param {Function} options.makeTrack - (entry, playlistTitle, requesterId) => queued track
 * @param {string} [options.limitLogSuffix] - Appended to the [QUEUE LIMIT] warning
 */
async function enqueuePlaylist(context, queue, url, { makeTrack, limitLogSuffix = '' }) {
    const { interaction, audioCache, backgroundDownloader } = context;

    let playlistInfo;
    try {
        playlistInfo = await getPlaylistEntries(url);
    } catch (e) {
        logger.warn(`[PLAYLIST READ ERROR] ${e.message}`);
        return await safeFollowUp(interaction, `⚠️ Playlist konnte nicht geladen werden: ${e.message}`);
    }

    let { playlistTitle, entries } = playlistInfo;
    entries = entries.filter(e => e.url);
    if (!entries.length) return await safeFollowUp(interaction, 'Keine gültigen Einträge in der Playlist gefunden.');

    // index parameter support
    let startIndex = 0;
    try {
        const u = new URL(url);
        if (u.searchParams.has('index')) {
            const idx = parseInt(u.searchParams.get('index'), 10);
            if (!isNaN(idx) && idx > 0 && idx <= entries.length) startIndex = idx - 1;
        }
    } catch { }

    // Reorder from startIndex
    const orderedEntries = [...entries.slice(startIndex), ...entries.slice(0, startIndex)];
    const [firstEntry, ...restEntries] = orderedEntries;

    // Progress message
    const progressMsg = await safeFollowUp(interaction, {
        embeds: [ui.playlistProgressEmbed({ playlistTitle, trackTitle: 'wird vorbereitet…', percent: 0, downloaded: 0, total: restEntries.length })]
    });
    queue.playlistProgressMsg = progressMsg;
    queue.lastProgressUpdate = Date.now();

    // Play first track immediately
    await handleSingleUrlPlay(context, firstEntry.url);

    // Add rest in background (respect queue size limit)
    let addedCount = 0;
    for (const e of restEntries) {
        if (remoteSongCount(queue) >= MAX_SONGS_PER_QUEUE) {
            logger.warn(`[QUEUE LIMIT][${interaction.guildId}] Queue full at ${MAX_SONGS_PER_QUEUE}${limitLogSuffix}`);
            break;
        }
        const track = makeTrack(e, playlistTitle, interaction.user.id);
        queue.songs.push(track);
        backgroundDownloader.addToQueue(interaction.guildId, track);
        addedCount++;
    }

    await safeFollowUp(interaction, {
        embeds: [ui.playlistAddedEmbed({
            playlistTitle, added: addedCount, total: restEntries.length, startIndex,
            limitReached: addedCount < restEntries.length, maxSongs: MAX_SONGS_PER_QUEUE
        })]
    });

    // Kick playback even if the first track's info/download failed — otherwise
    // the freshly filled queue would sit silent until the next command.
    ensureNextTrackDownloadedAndPlay(interaction.guildId, audioCache);
}

module.exports = {
    enqueuePlaylist
};
