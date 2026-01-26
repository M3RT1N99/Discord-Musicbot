// src/queue/QueueManager.js
// Global queue management for all guilds

const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus } = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { DOWNLOAD_DIR } = require('../config/constants');
const { downloadSingleTo } = require('../download/ytdlp');

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

    player.on("error", err => console.error(`[PLAYER ERROR][${guildId}]`, err?.message || err));

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

        // Ensure next track is downloaded and played
        ensureNextTrackDownloadedAndPlay(guildId).catch(e =>
            console.error("[ENSURE NEXT ERROR]", e?.message || e)
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
    const filename = `song_${Date.now()}_${randomUUID().slice(0, 8)}.m4a`;
    const filepath = path.join(DOWNLOAD_DIR, filename);

    // Notify channel
    if (q.lastInteractionChannel) {
        q.lastInteractionChannel.send(`⬇️ Lade: ${next.title || next.url}`.substring(0, 120)).catch(() => { });
    }

    try {
        q.isDownloading = true;
        console.log("[CALLING downloadSingleTo]", filepath, next.url);
        await downloadSingleTo(filepath, next.url, null);

        if (audioCache) {
            audioCache.set(next.url, filepath, { title: next.title, duration: next.duration });
        }

        next.filepath = filepath;
        q.isDownloading = false;
        playNextInGuild(guildId);
    } catch (e) {
        q.isDownloading = false;
        console.error("[NEXT DOWNLOAD ERROR]", e?.message || e);

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

    // Set current track for looping logic
    q.currentTrack = track;

    const resource = createAudioResource(track.filepath, { inlineVolume: true });
    resource.volume.setVolume((q.volume || 50) / 100);
    q.player.play(resource);

    // Send now playing embed
    if (q.lastInteractionChannel) {
        try {
            const embed = new EmbedBuilder()
                .setTitle("Now Playing")
                .setDescription(`[${track.title || path.basename(track.filepath)}](${track.url})`)
                .addFields(
                    { name: "Dauer", value: String(track.duration || "unbekannt"), inline: true },
                    { name: "Angefragt von", value: `<@${track.requesterId}>`, inline: true }
                )
                .setTimestamp();

            if (track.playlistTitle) {
                embed.addFields({ name: "Playlist", value: String(track.playlistTitle), inline: false });
            }

            q.lastInteractionChannel.send({ embeds: [embed] }).then(msg => {
                // Save "Now Playing" message for later deletion
                q.nowPlayingMessage = msg;
            }).catch(() => { });
        } catch (e) {
            console.warn("[EMBED SEND ERROR]", e.message);
        }
    }

    console.log(`[PLAY][${guildId}] Playing: ${track.title || track.filepath}`);
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
