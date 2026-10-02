// src/commands/maintenance.js
// /test, /debug and the admin commands /refresh and /clearcache

const fs = require('fs');
const path = require('path');
const { PermissionsBitField } = require('discord.js');
const { createAudioResource } = require('@discordjs/voice');
const { TOKEN } = require('../config/constants');
const { ensureQueueAndJoin } = require('./queueSession');
const { createCommandRest, commandsToJson, clearGlobalCommands, putGuildCommands } = require('./registration');
const ui = require('../ui/messages');
const logger = require('../utils/logger');

/**
 * /test – plays test.mp3 from project root
 */
async function handleTestCommand(context) {
    const { interaction, guildQueues, createPlayerForGuild, createGuildQueue } = context;
    const memberVoice = interaction.member?.voice?.channel;

    if (!memberVoice) {
        return interaction.reply({ content: 'Du musst in einem Sprachkanal sein!', ephemeral: true });
    }

    // Check for test.mp3 in common locations
    const possiblePaths = ['/app/test.mp3', path.join(process.cwd(), 'test.mp3')];
    const testFile = possiblePaths.find(p => fs.existsSync(p));

    if (!testFile) {
        return interaction.reply({ content: '❌ test.mp3 nicht gefunden.', ephemeral: true });
    }

    try {
        const queue = await ensureQueueAndJoin(context);
        const resource = createAudioResource(testFile, { inlineVolume: true });
        resource.volume.setVolume((queue.volume || 50) / 100);
        queue.player.play(resource);
        await interaction.reply({ content: '🎧 Test-Audio wird abgespielt!', ephemeral: true });
    } catch (e) {
        await interaction.reply({ content: `❌ Fehler: ${e.message}`, ephemeral: true });
    }
}

/**
 * /debug
 */
async function handleDebugCommand(context) {
    const { interaction, audioCache, guildQueues, backgroundDownloader, rateLimiter } = context;

    const embed = ui.debugEmbed({
        guildId: interaction.guildId,
        voiceChannel: interaction.member?.voice?.channel,
        cacheStats: audioCache.getStats(),
        queueCount: guildQueues.size,
        bgStats: backgroundDownloader.getStats()
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * /refresh – re-register slash commands (Admin only)
 */
async function handleRefreshCommand(context) {
    const { interaction, commandBuilders } = context;

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: '❌ Administrator-Berechtigung erforderlich.', ephemeral: true });
    }

    await interaction.deferReply();

    try {
        if (!TOKEN) {
            throw new Error('TOKEN environment variable not set');
        }
        if (!Array.isArray(commandBuilders) || commandBuilders.length === 0) {
            throw new Error('No command definitions available');
        }

        const rest = createCommandRest();
        const commandsJson = commandsToJson(commandBuilders);

        // Clear global commands to keep guild-scoped commands as the single source.
        await clearGlobalCommands(rest, interaction.client.application.id);
        await putGuildCommands(rest, interaction.client.application.id, interaction.guildId, commandsJson);

        logger.info(`[REFRESH] Commands refreshed for guild ${interaction.guildId}`);
        await interaction.editReply(`✅ Commands erfolgreich aktualisiert! (${commandsJson.length} Commands registriert)`);
    } catch (err) {
        logger.error(`[REFRESH ERROR] ${err.message}`);
        await interaction.editReply('❌ Fehler beim Registrieren der Commands.');
    }
}

/**
 * /clearcache – clear audio cache (Admin only)
 */
async function handleClearcacheCommand(context) {
    const { interaction, audioCache } = context;

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: '❌ Administrator-Berechtigung erforderlich.', ephemeral: true });
    }

    await interaction.deferReply();

    try {
        const stats = audioCache.getStats();
        const count = stats.size;

        audioCache.clear();

        logger.info(`[CACHE CLEAR] Cleared ${count} entries`);
        await interaction.editReply(`✅ Cache geleert! ${count} Einträge entfernt.`);
    } catch (err) {
        logger.error(`[CACHE CLEAR ERROR] ${err.message}`);
        await interaction.editReply('❌ Fehler beim Leeren des Caches.');
    }
}

module.exports = {
    handleTestCommand,
    handleDebugCommand,
    handleRefreshCommand,
    handleClearcacheCommand
};
