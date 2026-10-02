// src/commands/singleTrack.js
// Queues a single URL: cache hit or download with progress messages

const path = require('path');
const { MAX_SONGS_PER_QUEUE } = require('../config/constants');
const { downloadSingleTo, getVideoInfo } = require('../download/ytdlp');
const { newDownloadPath } = require('../download/downloadPaths');
const DownloadProgressManager = require('../download/ProgressManager');
const { ensureNextTrackDownloadedAndPlay } = require('../queue/QueueManager');
const { remoteSongCount } = require('../queue/queueOps');
const { ensureQueueAndJoin } = require('./queueSession');
const { safeFollowUp } = require('../utils/validation');
const ui = require('../ui/messages');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Helper: Download a single URL and play it (with progress embed)
// ---------------------------------------------------------------------------
async function handleSingleUrlPlay(context, url) {
    const { interaction, audioCache, guildQueues, backgroundDownloader } = context;
    const guildId = interaction.guildId;
    const queue = guildQueues.get(guildId);
    if (!queue) return;

    if (remoteSongCount(queue) >= MAX_SONGS_PER_QUEUE) {
        return await safeFollowUp(interaction, `❌ Queue-Limit erreicht (max. ${MAX_SONGS_PER_QUEUE} Songs).`);
    }

    // --- Cache hit ---
    if (audioCache.has(url)) {
        const filepath = audioCache.get(url);
        const entry = audioCache.getEntry(url);
        const title = entry?.meta?.title || path.basename(filepath);
        let duration = entry?.meta?.duration || 'unbekannt';

        queue.songs.push({ requesterId: interaction.user.id, title, filepath, url, duration });

        await safeFollowUp(interaction, { embeds: [ui.trackAddedEmbed({ title, url, duration, note: 'aus dem Cache — sofort verfügbar' })] });
        logger.info(`[CACHE HIT] ${title}`);

        // Fire-and-forget: the serialized chain may be busy with a long download —
        // never block the command response on it
        ensureNextTrackDownloadedAndPlay(guildId, audioCache);
        return;
    }

    // --- Fresh download ---
    logger.info(`[DOWNLOAD START] ${url}`);
    const filepath = newDownloadPath();

    let video;
    try {
        video = await getVideoInfo(url);
    } catch (err) {
        logger.error(`[VIDEO INFO ERROR] ${err.message}`);
        return await safeFollowUp(interaction, `❌ Konnte Video-Info nicht abrufen: ${err.message}`);
    }

    // Push the track synchronously so it keeps its queue position (a playlist's
    // remaining entries are pushed right after this call returns — the old
    // push-on-download-completion put track #1 behind the whole playlist).
    const track = { requesterId: interaction.user.id, title: video.title, filepath: null, url, duration: video.duration };
    queue.songs.push(track);

    const downloadMessages = [];
    let progressMsg = await safeFollowUp(interaction, { embeds: [ui.downloadProgressEmbed({ title: video.title, percent: 0 })] });
    downloadMessages.push(progressMsg);

    const progressManager = new DownloadProgressManager();
    const progressCb = (data) => {
        try {
            const parsed = progressManager.parseProgress(data);
            if (parsed && progressManager.shouldUpdate(parsed.percent)) {
                const embed = ui.downloadProgressEmbed({ title: video.title, percent: parsed.percent, speed: parsed.speed, eta: parsed.eta });
                if (progressMsg) progressMsg.edit({ embeds: [embed] }).catch(() => { });
            }
        } catch { }
    };

    const deleteDownloadMessages = () => {
        setTimeout(async () => {
            for (const msg of downloadMessages) {
                try { if (msg?.delete) await msg.delete(); } catch { }
            }
        }, 5000);
    };

    const dl = downloadSingleTo(filepath, url, progressCb);
    track._dlPromise = dl;
    dl
        .then(async () => {
            audioCache.set(url, filepath, { title: video.title, duration: video.duration });
            track.filepath = filepath;
            track._dlPromise = null;

            // Queue replaced/deleted during download (/stop, disconnect): the file
            // stays cached, but don't touch the new queue.
            if (guildQueues.get(guildId) !== queue) {
                logger.warn(`[DOWNLOAD] Queue gone for guild ${logger.guildTag(guildId)}, keeping track in cache only`);
                return;
            }

            const finishMsg = await safeFollowUp(interaction, { embeds: [ui.trackAddedEmbed({ title: video.title, url, duration: video.duration, note: 'Download abgeschlossen' })] });
            downloadMessages.push(finishMsg);
            deleteDownloadMessages();

            ensureNextTrackDownloadedAndPlay(guildId, audioCache);
        })
        .catch(async (err) => {
            track._dlPromise = null;
            logger.error(`[DOWNLOAD ERROR] ${err.message}`);

            const currentQueue = guildQueues.get(guildId);
            if (currentQueue === queue) {
                // Remove the failed track and kick the rest of the queue — without
                // this, a failed first playlist track left everything silently stuck.
                const i = queue.songs.indexOf(track);
                if (i !== -1) {
                    queue.songs.splice(i, 1);
                    queue._nextPrepared = false;
                }
                ensureNextTrackDownloadedAndPlay(guildId, audioCache);
            }

            const errorMsg = await safeFollowUp(interaction, `❌ Download fehlgeschlagen: ${err.message}`);
            downloadMessages.push(errorMsg);
            deleteDownloadMessages();
        });
}

/**
 * Joins the user's voice channel if needed, then queues a single URL.
 * A failed join is reported to the user instead of thrown.
 * @param {object} context - Handler context
 * @param {string} url - URL to play
 */
async function joinAndPlaySingle(context, url) {
    try {
        await ensureQueueAndJoin(context);
    } catch (e) {
        return await safeFollowUp(context.interaction, `❌ ${e.message}`);
    }
    return await handleSingleUrlPlay(context, url);
}

module.exports = {
    handleSingleUrlPlay,
    joinAndPlaySingle
};
