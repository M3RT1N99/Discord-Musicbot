// src/download/BackgroundDownloader.js
// Background download queue processor for playlist tracks

const path = require('path');
const { randomUUID } = require('crypto');
const { EmbedBuilder } = require('discord.js');
const { DOWNLOAD_DIR } = require('../config/constants');
const { downloadSingleTo, getVideoInfo } = require('./ytdlp');
const DownloadProgressManager = require('./ProgressManager');
const { truncateMessage } = require('../utils/formatting');

/**
 * Background Downloader for playlist tracks
 * Processes download queue in the background
 */
class BackgroundDownloader {
    constructor(audioCache, guildQueuesGetter) {
        this.active = false;
        this.queue = []; // Array of { guildId, track }
        this.audioCache = audioCache;
        this.getGuildQueues = guildQueuesGetter; // Function that returns guildQueues Map
    }

    /**
     * Adds track to download queue
     * @param {string} guildId - Guild ID
     * @param {object} track - Track object
     */
    addToQueue(guildId, track) {
        this.queue.push({ guildId, track });
        this.processQueue();
    }

    /**
     * Processes download queue
     */
    async processQueue() {
        if (this.active || this.queue.length === 0) return;
        this.active = true;

        const guildQueues = this.getGuildQueues();

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            const { guildId, track } = item;

            // Skip if track already has filepath or guild gone
            const guildQueue = guildQueues.get(guildId);
            if (!guildQueue || track.filepath) continue;

            // Check cache first
            if (this.audioCache.has(track.url)) {
                track.filepath = this.audioCache.get(track.url);
                const entry = this.audioCache.getEntry(track.url);
                if (entry?.meta) {
                    track.title = entry.meta.title || track.title;
                    track.duration = entry.meta.duration || track.duration;
                }
                this.updatePlaylistProgress(guildId, track, 100);
                continue;
            }

            try {
                // Generate filename
                const tempFilename = `song_${Date.now()}_${randomUUID().slice(0, 8)}.m4a`;
                const filepath = path.join(DOWNLOAD_DIR, tempFilename);

                // Download with progress
                const progressManager = new DownloadProgressManager();
                await downloadSingleTo(filepath, track.url, (data) => {
                    // Parse progress using unified manager
                    const parsed = progressManager.parseProgress(data);
                    if (parsed && progressManager.shouldUpdate(parsed.percent)) {
                        this.updatePlaylistProgress(guildId, track, parsed.percent, parsed.speed);
                    }
                });

                // Success
                track.filepath = filepath;

                // Get info for cache if title missing
                if (!track.duration || track.title === "Unbekannt") {
                    try {
                        const info = await getVideoInfo(track.url);
                        track.title = info.title;
                        track.duration = info.duration;
                    } catch { }
                }

                this.audioCache.set(track.url, filepath, { title: track.title, duration: track.duration });
                this.updatePlaylistProgress(guildId, track, 100);

            } catch (err) {
                console.warn(`[BG DOWNLOAD ERROR] ${track.url}: ${err.message}`);
                // Optional: remove failed track from guild queue?
                // For now we keep it, ensureNextTrack will try again or skip
            }

            // Small delay to yield event loop
            await new Promise(r => setTimeout(r, 200));
        }

        this.active = false;
    }

    /**
     * Updates playlist download progress message
     * @param {string} guildId - Guild ID
     * @param {object} track - Track being downloaded
     * @param {number} percent - Progress percentage
     * @param {string} speed - Download speed
     */
    updatePlaylistProgress(guildId, track, percent, speed) {
        const guildQueues = this.getGuildQueues();
        const guildQueue = guildQueues.get(guildId);
        if (!guildQueue || !guildQueue.playlistProgressMsg) return;

        const now = Date.now();
        // Throttle updates
        if (percent < 100 && now - (guildQueue.lastProgressUpdate || 0) < 3000) return;
        guildQueue.lastProgressUpdate = now;

        const total = guildQueue.songs.filter(s => s.playlistTitle === track.playlistTitle).length;
        const downloaded = guildQueue.songs.filter(s => s.playlistTitle === track.playlistTitle && s.filepath).length;

        const progressManager = new DownloadProgressManager();
        const bar = progressManager.createProgressBar(percent);

        const embed = new EmbedBuilder()
            .setTitle(`⬇️ Playlist Download: ${track.playlistTitle}`)
            .setDescription(`**Lade:** ${truncateMessage(track.title, 60)}\n${bar} ${percent.toFixed(0)}% ${speed ? `(${speed})` : ''}`)
            .setFooter({ text: `Fortschritt: ${downloaded}/${total} Songs bereit` })
            .setColor(percent === 100 ? 0x00FF00 : 0x1DB954);

        guildQueue.playlistProgressMsg.edit({ embeds: [embed] }).catch(() => {
            guildQueue.playlistProgressMsg = null; // Stop updating if message deleted
        });
    }

    /**
     * Gets queue statistics
     * @returns {object} Queue stats
     */
    getStats() {
        return {
            queueLength: this.queue.length,
            isActive: this.active
        };
    }
}

module.exports = BackgroundDownloader;
