// Global queue management for all guilds

const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType, VoiceConnectionStatus } = require('@discordjs/voice');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { DOWNLOAD_DIR, MAX_SONGS_PER_QUEUE } = require('../config/constants');
const { downloadSingleTo } = require('../download/ytdlp');
const logger = require('../utils/logger');

// Global guild queues map
const guildQueues = new Map();

/**
 * Creates an audio player for a guild
 * @param {string} guildId - Guild ID
 * @param {VoiceConnection} connection - Voice connection
 * @returns {AudioPlayer} Audio player instance
 */
function createPlayerForGuild(guildId, connection) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

    player.on("error", err => logger.error(`[PLAYER ERROR][${logger.guildTag(guildId)}] ${err?.message || err}`));

    // Voice disconnect cleanup — prevent orphaned queues and FFmpeg processes
    // Use a timeout to allow for temporary disconnects (region switches, brief network issues)
    let disconnectTimer = null;
    connection.on(VoiceConnectionStatus.Disconnected, () => {
        logger.warn(`[VOICE DISCONNECT][${logger.guildTag(guildId)}] Connection lost, waiting 15s for reconnect...`);
        if (disconnectTimer) clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
            // Only cleanup if still disconnected (not reconnected)
            if (connection.state.status === VoiceConnectionStatus.Disconnected ||
                connection.state.status === VoiceConnectionStatus.Destroyed) {
                logger.warn(`[VOICE DISCONNECT][${logger.guildTag(guildId)}] No reconnect after 15s, cleaning up`);
                cleanupGuildResources(guildId);
            }
        }, 15000);
    });
    connection.on(VoiceConnectionStatus.Ready, () => {
        // Cancel disconnect cleanup if we reconnected
        if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
            logger.info(`[VOICE RECONNECT][${logger.guildTag(guildId)}] Connection restored`);
        }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
        if (disconnectTimer) clearTimeout(disconnectTimer);
        logger.info(`[VOICE DESTROYED][${logger.guildTag(guildId)}] Connection destroyed, cleaning up`);
        cleanupGuildResources(guildId);
    });

    player.on(AudioPlayerStatus.Idle, () => {
        // Delete "Now Playing" message when song finishes
        const queue = guildQueues.get(guildId);
        if (!queue || queue.isCleaningUp) return;

        if (queue && queue.nowPlayingMessage) {
            queue.nowPlayingMessage.delete().catch(() => {
                // Ignore errors (e.g., message already deleted)
            });
            queue.nowPlayingMessage = null;
        }

        // Loop Logic
        const shouldLoopCurrentTrack = !queue.skipRequested;
        queue.skipRequested = false;

        if (shouldLoopCurrentTrack && queue.currentTrack) {
            if (queue.loopMode === 'song') {
                // Repeat current song (insert at front)
                queue.songs.unshift(queue.currentTrack);
            } else if (queue.loopMode === 'queue') {
                // Repeat current song (append at end)
                queue.songs.push(queue.currentTrack);
            }
        }

        // Ensure next track is downloaded and played (pass audioCache from queue)
        const queue2 = guildQueues.get(guildId);
        if (!queue2 || queue2.isCleaningUp) return;

        ensureNextTrackDownloadedAndPlay(guildId, queue2?.audioCache).catch(e =>
            logger.error(`[ENSURE NEXT ERROR] ${e?.message || e}`)
        );
    });

    return player;
}

/**
 * Ensures next track is downloaded and plays it
 * @param {string} guildId - Guild ID
 * @param {object} audioCache - Audio cache instance
 */
async function ensureNextTrackDownloadedAndPlay(guildId, audioCache, _depth = 0) {
    if (_depth > 10) {
        logger.warn(`[RECURSION LIMIT][${logger.guildTag(guildId)}] ensureNextTrackDownloadedAndPlay exceeded max depth, stopping`);
        return;
    }
    const q = guildQueues.get(guildId);
    if (!q || q.isCleaningUp) return;

    if (q.songs.length === 0) {
        // Nothing left -> cleanup connection
        q.isCleaningUp = true;
        try { q.connection.destroy(); } catch { }
        guildQueues.delete(guildId);
        return;
    }

    // If player already playing, do nothing
    if (q.player.state.status === AudioPlayerStatus.Playing) return;

    // Race condition check: already downloading?
    if (q.isDownloading) return;

    // Shuffle-aware selection: ensure songs[0] is the track we'll actually play
    prepareNextTrack(q);

    // Get next track (peek)
    const next = q.songs[0];
    if (!next) return;

    // If filepath exists -> play immediately
    if (next.filepath) {
        try {
            await fs.promises.access(next.filepath);
            playNextInGuild(guildId);
            return;
        } catch { }
    }

    // Need to download next.url (lazy)
    if (!next.url) {
        // Invalid entry -> drop and try next
        q.songs.shift();
        return await ensureNextTrackDownloadedAndPlay(guildId, audioCache, _depth + 1);
    }

    // Build filepath
    const filename = `song_${Date.now()}_${randomUUID().slice(0, 8)}.opus`;
    const filepath = path.join(DOWNLOAD_DIR, filename);

    // Notify channel
    if (q.lastInteractionChannel) {
        q.lastInteractionChannel.send({ content: `⬇️ Lade: ${next.title || next.url}`.substring(0, 120), flags: [MessageFlags.SuppressNotifications] }).catch(() => { });
    }

    try {
        q.isDownloading = true;
        logger.info(`[DOWNLOAD] ${filepath} from ${next.url}`);
        await downloadSingleTo(filepath, next.url, null);

        if (audioCache) {
            audioCache.set(next.url, filepath, { title: next.title, duration: next.duration });
        }

        next.filepath = filepath;
        q.isDownloading = false;
        q.consecutiveErrors = 0; // Reset error counter on success
        playNextInGuild(guildId);
    } catch (e) {
        q.isDownloading = false;
        logger.error(`[NEXT DOWNLOAD ERROR] ${e?.message || e}`);

        // Error counting
        q.consecutiveErrors = (q.consecutiveErrors || 0) + 1;

        if (q.consecutiveErrors >= 5) {
            if (q.lastInteractionChannel) {
                q.lastInteractionChannel.send({ content: "🛑 Zu viele Fehler hintereinander (5). Stoppe Wiedergabe um Spam zu vermeiden.", flags: [MessageFlags.SuppressNotifications] }).catch(() => { });
            }
            // Cleanup
            q.isCleaningUp = true;
            try { q.player.stop(); } catch { }
            try { q.connection.destroy(); } catch { }
            guildQueues.delete(guildId);
            return;
        }

        // Notify and remove track
        if (q.lastInteractionChannel) {
            const msg = `⚠️ Fehler beim Laden von ${next.title || next.url}: ${e.message}`;
            q.lastInteractionChannel.send({ content: msg.substring(0, 200), flags: [MessageFlags.SuppressNotifications] }).catch(() => { });
        }

        q.songs.shift();
        // Try next with delay to prevent spam
        setTimeout(() => ensureNextTrackDownloadedAndPlay(guildId, audioCache, _depth + 1), 500);
    }
}

/**
 * Persistent shuffle: when active, moves a random upcoming song to the front so
 * it becomes the next track. Idempotent per advance (guarded by q._nextPrepared)
 * so the pre-download peek in ensureNextTrackDownloadedAndPlay and the actual
 * playback in playNextInGuild always pick the same track. Skipped for loop-song
 * mode, which intentionally repeats the current track at the front of the queue.
 * @param {object} q - Guild queue
 */
function prepareNextTrack(q) {
    if (!q.shuffle || q._nextPrepared || q.loopMode === 'song' || q.songs.length <= 1) return;
    const i = Math.floor(Math.random() * q.songs.length);
    if (i !== 0) {
        const [picked] = q.songs.splice(i, 1);
        q.songs.unshift(picked);
    }
    q._nextPrepared = true;
}

/**
 * Plays next track in guild queue
 * @param {string} guildId - Guild ID
 */
function playNextInGuild(guildId) {
    const q = guildQueues.get(guildId);
    if (!q || q.isCleaningUp) return;

    prepareNextTrack(q);
    const track = q.songs.shift();
    q._nextPrepared = false; // next advance re-picks under current shuffle state
    if (!track) return;

    // Save previous track for "back" button, set current
    q.previousTrack = q.currentTrack || null;
    q.currentTrack = track;

    // Clean up any existing buffering process
    if (q.currentFfmpeg) {
        safeKillFfmpeg(q.currentFfmpeg);
        q.currentFfmpeg = null;
    }

    // Use ffmpeg to convert to Raw PCM (s16le) - the most stable timing format.
    // Small 2MB PassThrough jitter buffer (not the old 150MB Buffer.concat) smooths
    // playback start without the GC pauses that caused stuttering.
    const vol = (q.volume || 50) / 100;
    const ffmpeg = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-i', track.filepath,
        '-af', 'aresample=async=1',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const PREBUFFER_BYTES = 2 * 1024 * 1024;
    const stream = new PassThrough({ highWaterMark: PREBUFFER_BYTES });
    const chunks = [];
    let bufferedBytes = 0;
    let isPlaying = false;
    let ffmpegClosed = false;
    let stderr = '';

    const writeToStream = (chunk) => {
        if (stream.destroyed) return;
        if (!stream.write(chunk)) {
            ffmpeg.stdout.pause();
            stream.once('drain', () => {
                if (ffmpeg.stdout.readable) ffmpeg.stdout.resume();
            });
        }
    };

    const startPlayback = () => {
        if (isPlaying || chunks.length === 0) return;
        isPlaying = true;

        const resource = createAudioResource(stream, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });

        // Restore instant volume control
        resource.volume.setVolume(vol);
        q.currentResource = resource;

        q.player.play(resource);
        renderNowPlaying(guildId, track); // Show UI only when playing starts

        for (const chunk of chunks.splice(0)) {
            writeToStream(chunk);
        }
        bufferedBytes = 0;

        if (ffmpegClosed && !stream.destroyed) {
            stream.end();
        }
    };

    q.currentFfmpeg = ffmpeg;

    ffmpeg.stdout.on('data', (chunk) => {
        if (!isPlaying) {
            chunks.push(chunk);
            bufferedBytes += chunk.length;
            if (bufferedBytes >= PREBUFFER_BYTES) startPlayback();
            return;
        }

        writeToStream(chunk);
    });

    ffmpeg.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    ffmpeg.on('close', (code) => {
        q.currentFfmpeg = null;
        ffmpegClosed = true;

        if (chunks.length === 0 && !isPlaying) {
            logger.error(`[FFMPEG ERROR] No audio data for track ${track.title}: ${stderr.split('\n').slice(-3).join('\n')}`);
            stream.destroy();
            if (!q.isCleaningUp) playNextInGuild(guildId);
            return;
        }

        if (code !== 0 && !isPlaying) {
            logger.error(`[FFMPEG ERROR] Failed to buffer track ${track.title}: ${stderr.split('\n').slice(-3).join('\n')}`);
            stream.destroy();
            if (!q.isCleaningUp) playNextInGuild(guildId);
            return;
        }

        if (!isPlaying) startPlayback();
        if (!stream.destroyed) stream.end();

        if (code !== 0) {
            logger.warn(`[FFMPEG WARN] ffmpeg exited ${code} after playback started: ${stderr.split('\n').slice(-3).join('\n')}`);
        }
    });

    ffmpeg.on('error', (err) => {
        q.currentFfmpeg = null;
        logger.error(`[FFMPEG SPAWN ERROR] ${err.message}`);
        if (!isPlaying) {
            stream.destroy();
            if (!q.isCleaningUp) playNextInGuild(guildId);
        } else {
            stream.destroy(err);
        }
    });
}

/**
 * Renders and sends the Now Playing embed
 */
function renderNowPlaying(guildId, track) {
    const q = guildQueues.get(guildId);
    if (!q || q.isCleaningUp) return;

    // Send fancy Now Playing embed with player controls
    if (q.lastInteractionChannel) {
        try {
            const volPercent = q.volume || 50;
            const volBar = '█'.repeat(Math.round(volPercent / 10)) + '░'.repeat(10 - Math.round(volPercent / 10));
            const queuePos = q.songs.length > 0 ? `${q.songs.length} Song${q.songs.length > 1 ? 's' : ''} in Queue` : 'Queue leer';
            const title = track.title || path.basename(track.filepath);
            const description = track.url ? `**[${title}](${track.url})**` : `**${title}**`;

            const embed = new EmbedBuilder()
                .setTitle('🎶 Now Playing')
                .setDescription(description)
                .addFields(
                    { name: '⏱️ Dauer', value: String(track.duration || 'unbekannt'), inline: true },
                    { name: '👤 Angefragt von', value: `<@${track.requesterId}>`, inline: true },
                    { name: '🔊 Lautstärke', value: `\`${volBar}\` ${volPercent}%`, inline: true }
                )
                .setColor(0x1DB954)
                .setTimestamp();

            if (track.playlistTitle) {
                embed.addFields({ name: '📋 Playlist', value: String(track.playlistTitle), inline: true });
            }
            embed.setFooter({ text: `🎵 ${queuePos} • ${q.loopMode !== 'off' ? (q.loopMode === 'song' ? '🔂 Repeat Song' : '🔁 Repeat Queue') : '➡️ Normal'}` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`np_prev|${guildId}`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_pause|${guildId}`).setEmoji('⏯️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`np_skip|${guildId}`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_voldn|${guildId}`).setEmoji('🔉').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_volup|${guildId}`).setEmoji('🔊').setStyle(ButtonStyle.Secondary)
            );
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`np_shuffle|${guildId}`).setLabel('Shuffle').setEmoji('🔀').setStyle(q.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_savequeue|${guildId}`).setLabel('Queue speichern').setEmoji('💾').setStyle(ButtonStyle.Success)
            );

            // Delete old "Now Playing" message before sending new one
            if (q.nowPlayingMessage) {
                q.nowPlayingMessage.delete().catch(() => { });
                q.nowPlayingMessage = null;
            }

            q.lastInteractionChannel.send({ embeds: [embed], components: [row, row2], flags: [MessageFlags.SuppressNotifications] }).then(msg => {
                q.nowPlayingMessage = msg;
            }).catch(() => { });
        } catch (e) {
            logger.warn(`[EMBED SEND ERROR] ${e.message}`);
        }
    }

    logger.info(`[PLAY][${logger.guildTag(guildId)}] Playing: ${track.title || track.filepath}`);
}

/**
 * Gets guild queue or creates new one
 * @param {string} guildId - Guild ID
 * @returns {object|null} Guild queue
 */
function getGuildQueue(guildId) {
    return guildQueues.get(guildId) || null;
}

/**
 * Creates a new guild queue
 * @param {string} guildId - Guild ID
 * @param {VoiceConnection} connection - Voice connection
 * @param {AudioPlayer} player - Audio player
 * @param {TextChannel} channel - Text channel for messages
 * @returns {object} Guild queue
 */
function createGuildQueue(guildId, connection, player, channel) {
    const queue = {
        connection,
        player,
        songs: [],
        volume: 50,
        shuffle: false,
        _nextPrepared: false, // internal: shuffle pick locked in for the next advance
        loopMode: 'off', // 'off', 'song', 'queue'
        lastInteractionChannel: channel,
        consecutiveErrors: 0,
        skipRequested: false,
        isCleaningUp: false
    };
    guildQueues.set(guildId, queue);
    return queue;
}

/**
 * Safely kills an FFmpeg process with SIGTERM -> SIGKILL fallback
 * @param {ChildProcess} ffmpeg - FFmpeg process
 */
function safeKillFfmpeg(ffmpeg) {
    if (!ffmpeg || ffmpeg.killed) return;
    try {
        ffmpeg.kill('SIGTERM');
        // Force-kill after 5 seconds if still alive
        const killTimeout = setTimeout(() => {
            try { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); } catch { }
        }, 5000);
        killTimeout.unref();
    } catch { }
}

/**
 * Cleans up all resources for a guild (FFmpeg, player, queue)
 * @param {string} guildId - Guild ID
 */
function cleanupGuildResources(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return;
    queue.isCleaningUp = true;

    // Kill FFmpeg process
    if (queue.currentFfmpeg) {
        safeKillFfmpeg(queue.currentFfmpeg);
        queue.currentFfmpeg = null;
    }

    // Stop player
    try { queue.player.stop(); } catch { }

    // Clear references to help GC
    queue.songs.length = 0;
    queue.currentTrack = null;
    queue.previousTrack = null;
    queue.currentResource = null;
    if (queue.nowPlayingMessage) {
        queue.nowPlayingMessage.delete().catch(() => { });
    }
    queue.nowPlayingMessage = null;
    queue.playlistProgressMsg = null;

    guildQueues.delete(guildId);
    logger.info(`[CLEANUP][${logger.guildTag(guildId)}] Guild resources cleaned up`);
}

/**
 * Deletes guild queue
 * @param {string} guildId - Guild ID
 */
function deleteGuildQueue(guildId) {
    const queue = guildQueues.get(guildId);
    if (queue) {
        queue.isCleaningUp = true;
        if (queue.currentFfmpeg) {
            safeKillFfmpeg(queue.currentFfmpeg);
            queue.currentFfmpeg = null;
        }
        try { queue.player.stop(); } catch { }
        try { queue.connection.destroy(); } catch { }
        queue.songs.length = 0;
        queue.currentTrack = null;
        queue.previousTrack = null;
        queue.currentResource = null;
        if (queue.nowPlayingMessage) {
            queue.nowPlayingMessage.delete().catch(() => { });
        }
        queue.nowPlayingMessage = null;
        guildQueues.delete(guildId);
    }
}

/**
 * Requests a skip for the current track without re-adding it in repeat modes.
 * @param {string} guildId - Guild ID
 * @returns {boolean} True if a queue existed
 */
function skipCurrentTrack(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue || queue.isCleaningUp) return false;

    queue.skipRequested = true;
    if (queue.currentFfmpeg) {
        safeKillFfmpeg(queue.currentFfmpeg);
        queue.currentFfmpeg = null;
    }

    try { queue.player.stop(); } catch { }
    return true;
}

module.exports = {
    guildQueues,
    createPlayerForGuild,
    ensureNextTrackDownloadedAndPlay,
    playNextInGuild,
    getGuildQueue,
    createGuildQueue,
    deleteGuildQueue,
    cleanupGuildResources,
    skipCurrentTrack
};
