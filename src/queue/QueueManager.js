// Global queue management for all guilds

const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { EmbedBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { DOWNLOAD_DIR } = require('../config/constants');
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

    player.on("error", err => logger.error(`[PLAYER ERROR][${guildId}] ${err?.message || err}`));

    player.on(AudioPlayerStatus.Idle, () => {
        // Delete "Now Playing" message when song finishes
        const queue = guildQueues.get(guildId);
        if (queue && queue.nowPlayingMessage) {
            queue.nowPlayingMessage.delete().catch(() => {
                // Ignore errors (e.g., message already deleted)
            });
            queue.nowPlayingMessage = null;
        }

        // Loop Logic
        if (queue && queue.currentTrack) {
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
async function ensureNextTrackDownloadedAndPlay(guildId, audioCache) {
    const q = guildQueues.get(guildId);
    if (!q) return;

    if (q.songs.length === 0) {
        // Nothing left -> cleanup connection
        try { q.connection.destroy(); } catch { }
        guildQueues.delete(guildId);
        return;
    }

    // If player already playing, do nothing
    if (q.player.state.status === AudioPlayerStatus.Playing) return;

    // Race condition check: already downloading?
    if (q.isDownloading) return;

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
        return await ensureNextTrackDownloadedAndPlay(guildId, audioCache);
    }

    // Build filepath
    const filename = `song_${Date.now()}_${randomUUID().slice(0, 8)}.opus`;
    const filepath = path.join(DOWNLOAD_DIR, filename);

    // Notify channel
    if (q.lastInteractionChannel) {
        q.lastInteractionChannel.send(`⬇️ Lade: ${next.title || next.url}`.substring(0, 120)).catch(() => { });
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
        playNextInGuild(guildId);
    } catch (e) {
        q.isDownloading = false;
        logger.error(`[NEXT DOWNLOAD ERROR] ${e?.message || e}`);

        // Error counting
        q.consecutiveErrors = (q.consecutiveErrors || 0) + 1;

        if (q.consecutiveErrors >= 5) {
            if (q.lastInteractionChannel) {
                q.lastInteractionChannel.send("🛑 Zu viele Fehler hintereinander (5). Stoppe Wiedergabe um Spam zu vermeiden.").catch(() => { });
            }
            // Cleanup
            q.player.stop();
            try { q.connection.destroy(); } catch { }
            guildQueues.delete(guildId);
            return;
        }

        // Notify and remove track
        if (q.lastInteractionChannel) {
            const msg = `⚠️ Fehler beim Laden von ${next.title || next.url}: ${e.message}`;
            q.lastInteractionChannel.send(msg.substring(0, 200)).catch(() => { });
        }

        q.songs.shift();
        // Try next with delay to prevent spam
        setTimeout(() => ensureNextTrackDownloadedAndPlay(guildId, audioCache), 500);
    }
}

/**
 * Plays next track in guild queue
 * @param {string} guildId - Guild ID
 */
function playNextInGuild(guildId) {
    const q = guildQueues.get(guildId);
    if (!q) return;

    const track = q.songs.shift();
    if (!track) return;

    // Save previous track for "back" button, set current
    q.previousTrack = q.currentTrack || null;
    q.currentTrack = track;

    // Clean up any existing buffering process
    if (q.currentFfmpeg) {
        try { q.currentFfmpeg.kill('SIGKILL'); } catch { }
        q.currentFfmpeg = null;
    }

    // Use ffmpeg to convert to Raw PCM (s16le) - the most stable timing format
    const vol = (q.volume || 50) / 100;
    const ffmpeg = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-i', track.filepath,
        '-af', 'aresample=async=1', // Sync clock: prevents warping/leiern
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    // Aggressive PCM Pre-Buffering: Load entire song into RAM before playback
    const chunks = [];
    let bufferedBytes = 0;
    let isPlaying = false;
    const MAX_PREBUFFER = 150 * 1024 * 1024; // 150MB cap (~13min audio)

    const startPlayback = () => {
        if (isPlaying || chunks.length === 0) return;
        isPlaying = true;

        const fullBuffer = Buffer.concat(chunks);
        const stream = new PassThrough();
        stream.end(fullBuffer);

        const resource = createAudioResource(stream, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });

        // Restore instant volume control
        resource.volume.setVolume(vol);
        q.currentResource = resource;

        q.player.play(resource);
        renderNowPlaying(guildId, track); // Show UI only when playing starts
    };

    q.currentFfmpeg = ffmpeg;

    ffmpeg.stdout.on('data', (chunk) => {
        chunks.push(chunk);
        bufferedBytes += chunk.length;
        // If file is huge, start playing after 10MB to avoid OOM
        if (bufferedBytes > MAX_PREBUFFER) startPlayback();
    });

    ffmpeg.on('close', (code) => {
        q.currentFfmpeg = null;
        if (code !== 0 && chunks.length === 0) {
            logger.error(`[FFMPEG ERROR] Failed to buffer track ${track.title}`);
            playNextInGuild(guildId); // Skip to next on total failure
            return;
        }
        startPlayback();
    });

    ffmpeg.on('error', (err) => {
        q.currentFfmpeg = null;
        logger.error(`[FFMPEG SPAWN ERROR] ${err.message}`);
        playNextInGuild(guildId);
    });
}

/**
 * Renders and sends the Now Playing embed
 */
function renderNowPlaying(guildId, track) {
    const q = guildQueues.get(guildId);
    if (!q) return;

    // Send fancy Now Playing embed with player controls
    if (q.lastInteractionChannel) {
        try {
            const volPercent = q.volume || 50;
            const volBar = '█'.repeat(Math.round(volPercent / 10)) + '░'.repeat(10 - Math.round(volPercent / 10));
            const queuePos = q.songs.length > 0 ? `${q.songs.length} Song${q.songs.length > 1 ? 's' : ''} in Queue` : 'Queue leer';

            const embed = new EmbedBuilder()
                .setTitle('🎶 Now Playing')
                .setDescription(`**[${track.title || path.basename(track.filepath)}](${track.url || ''})**`)
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

            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`np_prev|${guildId}`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_pause|${guildId}`).setEmoji('⏯️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`np_skip|${guildId}`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_voldn|${guildId}`).setEmoji('🔉').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_volup|${guildId}`).setEmoji('🔊').setStyle(ButtonStyle.Secondary)
            );

            // Delete old "Now Playing" message before sending new one
            if (q.nowPlayingMessage) {
                q.nowPlayingMessage.delete().catch(() => { });
                q.nowPlayingMessage = null;
            }

            q.lastInteractionChannel.send({ embeds: [embed], components: [row] }).then(msg => {
                q.nowPlayingMessage = msg;
            }).catch(() => { });
        } catch (e) {
            logger.warn(`[EMBED SEND ERROR] ${e.message}`);
        }
    }

    logger.info(`[PLAY][${guildId}] Playing: ${track.title || track.filepath}`);
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
        loopMode: 'off', // 'off', 'song', 'queue'
        lastInteractionChannel: channel,
        consecutiveErrors: 0
    };
    guildQueues.set(guildId, queue);
    return queue;
}

/**
 * Deletes guild queue
 * @param {string} guildId - Guild ID
 */
function deleteGuildQueue(guildId) {
    const queue = guildQueues.get(guildId);
    if (queue) {
        queue.player.stop();
        try { queue.connection.destroy(); } catch { }
        guildQueues.delete(guildId);
    }
}

module.exports = {
    guildQueues,
    createPlayerForGuild,
    ensureNextTrackDownloadedAndPlay,
    playNextInGuild,
    getGuildQueue,
    createGuildQueue,
    deleteGuildQueue
};
