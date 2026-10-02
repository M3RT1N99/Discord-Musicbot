// src/commands/nowPlayingButtons.js
// Buttons on the Now Playing card (prev, pause, skip, volume, shuffle, loop, save queue)

const { AttachmentBuilder, MessageFlags: DjsMessageFlags } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { ensureNextTrackDownloadedAndPlay, skipCurrentTrack } = require('../queue/QueueManager');
const { setQueueVolume, toggleShuffle } = require('../queue/queueOps');
const ui = require('../ui/messages');
const logger = require('../utils/logger');

/**
 * Replies (ephemeral) with the current + queued tracks that have a URL —
 * as text, or as a .txt attachment when the list is too long for a message.
 * @param {object} interaction - Button interaction
 * @param {object} queue - Guild queue
 */
function replyWithSavedQueue(interaction, queue) {
    // Collect all tracks: current + queued
    const allTracks = [];
    if (queue.currentTrack) allTracks.push(queue.currentTrack);
    allTracks.push(...queue.songs);

    const tracksWithUrl = allTracks.filter(t => t.url);
    if (tracksWithUrl.length === 0) {
        return interaction.reply({ content: '📋 Queue ist leer — nichts zu speichern.', ephemeral: true });
    }

    // Format track list
    const lines = tracksWithUrl.map((t, i) =>
        `${i + 1}. ${t.title || 'Unbekannt'} — ${t.url}`
    );
    const header = `💾 Queue gespeichert (${tracksWithUrl.length} Songs)\n\n`;

    // If short enough, send as text message
    if (header.length + lines.join('\n').length < 1900) {
        return interaction.reply({
            content: header + lines.join('\n'),
            ephemeral: true
        });
    }

    // Otherwise send as .txt file attachment
    const fileContent = lines.join('\n');
    const attachment = new AttachmentBuilder(
        Buffer.from(fileContent, 'utf-8'),
        { name: `queue_${Date.now()}.txt` }
    );
    return interaction.reply({
        content: `💾 Queue gespeichert (${tracksWithUrl.length} Songs):`,
        files: [attachment],
        ephemeral: true
    });
}

/**
 * Handle Now Playing button interactions (prev, pause, skip, vol up/down)
 */
async function handleNowPlayingButton(context) {
    const { interaction, guildQueues } = context;
    const customId = interaction.customId;
    const parts = customId.split('|');
    if (parts.length < 2) return;

    const [action, guildId] = parts;
    const queue = guildQueues.get(guildId);

    if (!queue) {
        return interaction.reply({ content: '❌ Keine aktive Wiedergabe.', ephemeral: true });
    }

    switch (action) {
        case 'np_pause': {
            if (queue.player.state.status === AudioPlayerStatus.Playing) {
                queue.player.pause();
            } else {
                // Covers Paused AND AutoPaused (no-op when Idle)
                queue.player.unpause();
            }
            break;
        }
        case 'np_skip': {
            skipCurrentTrack(guildId); // Triggers Idle → next track
            // Don't update embed, a new one will be sent for the next track
            return interaction.deferUpdate();
        }
        case 'np_prev': {
            if (queue.previousTrack) {
                // Put current track back and play previous
                if (queue.currentTrack) {
                    queue.songs.unshift(queue.currentTrack);
                }
                queue.songs.unshift(queue.previousTrack);
                queue.previousTrack = null;
                // Pin this explicit pick — with shuffle active, prepareNextTrack
                // would otherwise re-roll a random track over the previous one
                queue._nextPrepared = true;
                if (queue.player.state.status === AudioPlayerStatus.Idle && !queue.currentFfmpeg) {
                    ensureNextTrackDownloadedAndPlay(guildId, queue.audioCache);
                } else {
                    skipCurrentTrack(guildId); // Triggers Idle → plays the unshifted prev track
                }
                return interaction.deferUpdate();
            } else {
                return interaction.reply({ content: '⏮️ Kein vorheriger Song vorhanden.', ephemeral: true });
            }
        }
        case 'np_volup': {
            setQueueVolume(queue, Math.min(100, (queue.volume || 50) + 10));
            break;
        }
        case 'np_voldn': {
            setQueueVolume(queue, Math.max(0, (queue.volume || 50) - 10));
            break;
        }
        case 'np_shuffle': {
            toggleShuffle(queue);
            break;
        }
        case 'np_loop': {
            // Cycle: off -> song -> queue -> off
            queue.loopMode = queue.loopMode === 'off' ? 'song' : queue.loopMode === 'song' ? 'queue' : 'off';
            break;
        }
        case 'np_savequeue':
            return replyWithSavedQueue(interaction, queue);
        default:
            return;
    }

    // Rebuild and update the card in-place
    try {
        const track = queue.currentTrack;
        if (!track) return interaction.deferUpdate();

        // Messages from before the Components-V2 switch can't be edited into the
        // new card format — just acknowledge; the next track brings the new card.
        if (!interaction.message?.flags?.has(DjsMessageFlags.IsComponentsV2)) {
            return interaction.deferUpdate();
        }

        const card = ui.buildNowPlayingCard(guildId, queue, track);
        await interaction.update({ components: [card] });
    } catch (e) {
        logger.warn(`[NP BUTTON] ${e.message}`);
        // Give user feedback instead of failing silently
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Aktion fehlgeschlagen.', ephemeral: true }).catch(() => { });
        } else {
            await interaction.deferUpdate().catch(() => { });
        }
    }
}

module.exports = {
    handleNowPlayingButton
};
