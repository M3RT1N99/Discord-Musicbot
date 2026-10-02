// src/commands/playback.js
// Playback control commands: pause, resume, skip, stop, queue, volume, leave, shuffle, repeat

const { MessageFlags: DjsMessageFlags } = require('discord.js');
const { skipCurrentTrack } = require('../queue/QueueManager');
const { setQueueVolume, toggleShuffle } = require('../queue/queueOps');
const ui = require('../ui/messages');

/**
 * Refreshes the Now Playing card after a slash command changes queue state
 * (pause, volume, loop, shuffle), so buttons and status line stay in sync.
 * @param {string} guildId - Guild ID
 * @param {object} queue - Guild queue
 */
function refreshNowPlayingCard(guildId, queue) {
    if (!queue?.nowPlayingMessage || !queue.currentTrack) return;
    if (!queue.nowPlayingMessage.flags?.has(DjsMessageFlags.IsComponentsV2)) return;
    const card = ui.buildNowPlayingCard(guildId, queue, queue.currentTrack);
    queue.nowPlayingMessage.edit({ components: [card] }).catch(() => { });
}

/**
 * /pause
 */
async function handlePauseCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) return interaction.reply({ content: '❌ Keine aktive Wiedergabe.', ephemeral: true });

    queue.player.pause();
    refreshNowPlayingCard(interaction.guildId, queue);
    await interaction.reply({ content: '⏸️ Pausiert', ephemeral: true });
}

/**
 * /resume
 */
async function handleResumeCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) return interaction.reply({ content: '❌ Keine aktive Wiedergabe.', ephemeral: true });

    queue.player.unpause();
    refreshNowPlayingCard(interaction.guildId, queue);
    await interaction.reply({ content: '▶️ Fortgesetzt', ephemeral: true });
}

/**
 * /skip
 */
async function handleSkipCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) return interaction.reply({ content: '❌ Keine aktive Wiedergabe.', ephemeral: true });

    // Delete "Now Playing" message
    if (queue.nowPlayingMessage) {
        queue.nowPlayingMessage.delete().catch(() => { });
        queue.nowPlayingMessage = null;
    }

    skipCurrentTrack(interaction.guildId); // Triggers Idle -> next track
    await interaction.reply({ content: '⏭️ Übersprungen', ephemeral: true });
}

/**
 * /stop
 */
async function handleStopCommand(context) {
    const { interaction, guildQueues, deleteGuildQueue } = context;
    const guildId = interaction.guildId;
    const queue = guildQueues.get(guildId);

    if (!queue) return interaction.reply({ content: '❌ Keine aktive Wiedergabe.', ephemeral: true });

    // Delete "Now Playing" message
    if (queue.nowPlayingMessage) {
        queue.nowPlayingMessage.delete().catch(() => { });
    }

    deleteGuildQueue(guildId);
    await interaction.reply({ content: '⏹️ Gestoppt und Queue geleert', ephemeral: true });
}

/**
 * /queue
 */
async function handleQueueCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue || (queue.songs.length === 0 && !queue.currentTrack)) {
        return interaction.reply({ content: '📋 Queue ist leer.', ephemeral: true });
    }

    await interaction.reply({ embeds: [ui.queueEmbed(queue)] });
}

/**
 * /volume – setzt Lautstärke UND wendet sie auf den Player an
 */
async function handleVolumeCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);
    const value = interaction.options.getInteger('wert');

    if (!queue) return interaction.reply({ content: '❌ Keine aktive Wiedergabe.', ephemeral: true });

    const clampedValue = Math.max(0, Math.min(100, value));
    setQueueVolume(queue, clampedValue);

    refreshNowPlayingCard(interaction.guildId, queue);
    await interaction.reply({ content: `🔊 Lautstärke auf ${clampedValue} % gesetzt`, ephemeral: true });
}

/**
 * /leave
 */
async function handleLeaveCommand(context) {
    const { interaction, deleteGuildQueue, guildQueues } = context;
    const guildId = interaction.guildId;

    if (!guildQueues.get(guildId)) {
        return interaction.reply({ content: '❌ Ich bin in keinem Sprachkanal.', ephemeral: true });
    }

    deleteGuildQueue(guildId);
    await interaction.reply({ content: '👋 Tschüss!', ephemeral: true });
}

/**
 * /shuffle – toggle persistent shuffle mode. While active, each next track is
 * picked at random from the queue (no repeats) and newly added songs get mixed
 * in automatically. The actual random selection happens in QueueManager.
 */
async function handleShuffleCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) return interaction.reply({ content: '❌ Keine Queue vorhanden.', ephemeral: true });

    toggleShuffle(queue);

    refreshNowPlayingCard(interaction.guildId, queue);
    await interaction.reply({ content: `🔀 Shuffle ${queue.shuffle ? 'aktiviert' : 'deaktiviert'}`, ephemeral: true });
}

/**
 * /repeatsingle
 */
async function handleRepeatSingleCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) return interaction.reply({ content: '❌ Keine Queue vorhanden.', ephemeral: true });

    queue.loopMode = queue.loopMode === 'song' ? 'off' : 'song';
    refreshNowPlayingCard(interaction.guildId, queue);
    const emoji = queue.loopMode === 'song' ? '🔂' : '➡️';
    await interaction.reply({ content: `${emoji} Song-Loop: ${queue.loopMode === 'song' ? 'an' : 'aus'}`, ephemeral: true });
}

/**
 * /repeat
 */
async function handleRepeatCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) return interaction.reply({ content: '❌ Keine Queue vorhanden.', ephemeral: true });

    queue.loopMode = queue.loopMode === 'queue' ? 'off' : 'queue';
    refreshNowPlayingCard(interaction.guildId, queue);
    const emoji = queue.loopMode === 'queue' ? '🔁' : '➡️';
    await interaction.reply({ content: `${emoji} Queue-Loop: ${queue.loopMode === 'queue' ? 'an' : 'aus'}`, ephemeral: true });
}

module.exports = {
    handlePauseCommand,
    handleResumeCommand,
    handleSkipCommand,
    handleStopCommand,
    handleQueueCommand,
    handleVolumeCommand,
    handleLeaveCommand,
    handleShuffleCommand,
    handleRepeatSingleCommand,
    handleRepeatCommand
};
