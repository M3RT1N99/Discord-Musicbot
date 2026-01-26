// src/commands/commandHandlers.js
// Temporary command handlers - will be refactored into individual files
// This file provides a bridge between the new modular architecture and legacy command logic

const path = require('path');

// Note: The actual command logic is still in legacy_commands.js
// This is a temporary solution to make the refactored bot work
// TODO: Extract each command into its own file in src/commands/

/**
 * Handles the /play command
 */
async function handlePlayCommand(context) {
    // TODO: Implement in separate file
    const { interaction } = context;
    await interaction.reply({ content: "⚠️ Command handlers being refactored. Please wait for full implementation.", ephemeral: true });
}

/**
 * Handles the /select command
 */
async function handleSelectCommand(context) {
    const { interaction } = context;
    await interaction.reply({ content: "⚠️ Command handlers being refactored. Please wait for full implementation.", ephemeral: true });
}

/**
 * Handles the /pause command
 */
async function handlePauseCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) {
        return interaction.reply({ content: "❌ Keine aktive Wiedergabe.", ephemeral: true });
    }

    queue.player.pause();
    await interaction.reply("⏸️ Pausiert");
}

/**
 * Handles the /resume command
 */
async function handleResumeCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) {
        return interaction.reply({ content: "❌ Keine aktive Wiedergabe.", ephemeral: true });
    }

    queue.player.unpause();
    await interaction.reply("▶️ Fortgesetzt");
}

/**
 * Handles the /skip command
 */
async function handleSkipCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) {
        return interaction.reply({ content: "❌ Keine aktive Wiedergabe.", ephemeral: true });
    }

    queue.player.stop(); // Triggers next track
    await interaction.reply("⏭️ Übersprungen");
}

/**
 * Handles the /stop command
 */
async function handleStopCommand(context) {
    const { interaction, guildQueues, deleteGuildQueue } = context;
    const guildId = interaction.guildId;
    const queue = guildQueues.get(guildId);

    if (!queue) {
        return interaction.reply({ content: "❌ Keine aktive Wiedergabe.", ephemeral: true });
    }

    deleteGuildQueue(guildId);
    await interaction.reply("⏹️ Gestoppt und Queue geleert");
}

/**
 * Handles the /queue command
 */
async function handleQueueCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue || queue.songs.length === 0) {
        return interaction.reply({ content: "📋 Queue ist leer.", ephemeral: true });
    }

    const list = queue.songs.slice(0, 10).map((s, i) =>
        `${i + 1}. ${s.title || 'Unbekannt'}`
    ).join('\n');

    const message = `📋 **Queue (${queue.songs.length} Songs)**\n\n${list}${queue.songs.length > 10 ? '\n... und mehr' : ''}`;
    await interaction.reply(message);
}

/**
 * Handles the /volume command
 */
async function handleVolumeCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);
    const value = interaction.options.getInteger("wert");

    if (!queue) {
        return interaction.reply({ content: "❌ Keine aktive Wiedergabe.", ephemeral: true });
    }

    if (value < 0 || value > 100) {
        return interaction.reply({ content: "❌ Lautstärke muss zwischen 0 und 100 liegen.", ephemeral: true });
    }

    queue.volume = value;
    await interaction.reply(`🔊 Lautstärke auf ${value}% gesetzt`);
}

/**
 * Handles the /leave command
 */
async function handleLeaveCommand(context) {
    const { interaction, deleteGuildQueue } = context;
    const guildId = interaction.guildId;

    deleteGuildQueue(guildId);
    await interaction.reply("👋 Tschüss!");
}

/**
 * Handles the /shuffle command
 */
async function handleShuffleCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) {
        return interaction.reply({ content: "❌ Keine Queue vorhanden.", ephemeral: true });
    }

    const { shuffleArray } = require('../utils/formatting');
    queue.shuffle = !queue.shuffle;

    if (queue.shuffle) {
        shuffleArray(queue.songs);
        await interaction.reply("🔀 Shuffle aktiviert");
    } else {
        await interaction.reply("➡️ Shuffle deaktiviert");
    }
}

/**
 * Handles the /test command
 */
async function handleTestCommand(context) {
    const { interaction } = context;
    await interaction.reply({ content: "🧪 Test command - not yet implemented", ephemeral: true });
}

/**
 * Handles the /debug command
 */
async function handleDebugCommand(context) {
    const { interaction, audioCache, guildQueues } = context;

    const cacheStats = audioCache.getStats();
    const queueCount = guildQueues.size;

    const info = `🐛 **Debug Info**\n\n` +
        `📦 Cache: ${cacheStats.size}/${cacheStats.maxEntries} (${cacheStats.utilizationPercent}%)\n` +
        `🎵 Active Queues: ${queueCount}\n` +
        `🤖 Bot: Online`;

    await interaction.reply({ content: info, ephemeral: true });
}

/**
 * Handles the /playcache command
 */
async function handlePlaycacheCommand(context) {
    const { interaction } = context;
    await interaction.reply({ content: "⚠️ Command being refactored.", ephemeral: true });
}

/**
 * Handles the /refresh command
 */
async function handleRefreshCommand(context) {
    const { interaction } = context;

    if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Administrator-Berechtigung erforderlich.", ephemeral: true });
    }

    await interaction.reply({ content: "🔄 Commands würden hier neu registriert (Feature wird implementiert).", ephemeral: true });
}

/**
 * Handles the /clearcache command
 */
async function handleClearcacheCommand(context) {
    const { interaction, audioCache } = context;

    if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Administrator-Berechtigung erforderlich.", ephemeral: true });
    }

    // audioCache.clear(); // TODO: implement clear method
    await interaction.reply({ content: "🗑️ Cache-Clearing wird implementiert.", ephemeral: true });
}

/**
 * Handles the /repeatsingle command
 */
async function handleRepeatSingleCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) {
        return interaction.reply({ content: "❌ Keine Queue vorhanden.", ephemeral: true });
    }

    queue.loopMode = queue.loopMode === 'song' ? 'off' : 'song';
    const emoji = queue.loopMode === 'song' ? '🔂' : '➡️';
    await interaction.reply(`${emoji} Loop Single: ${queue.loopMode === 'song' ? 'An' : 'Aus'}`);
}

/**
 * Handles the /repeat command
 */
async function handleRepeatCommand(context) {
    const { interaction, guildQueues } = context;
    const queue = guildQueues.get(interaction.guildId);

    if (!queue) {
        return interaction.reply({ content: "❌ Keine Queue vorhanden.", ephemeral: true });
    }

    queue.loopMode = queue.loopMode === 'queue' ? 'off' : 'queue';
    const emoji = queue.loopMode === 'queue' ? '🔁' : '➡️';
    await interaction.reply(`${emoji} Loop Queue: ${queue.loopMode === 'queue' ? 'An' : 'Aus'}`);
}

module.exports = {
    handlePlayCommand,
    handleSelectCommand,
    handlePauseCommand,
    handleResumeCommand,
    handleSkipCommand,
    handleStopCommand,
    handleQueueCommand,
    handleVolumeCommand,
    handleLeaveCommand,
    handleShuffleCommand,
    handleTestCommand,
    handleDebugCommand,
    handlePlaycacheCommand,
    handleRefreshCommand,
    handleClearcacheCommand,
    handleRepeatSingleCommand,
    handleRepeatCommand
};
