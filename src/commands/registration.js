// src/commands/registration.js
// Slash command registration via the Discord REST API (guild-scoped only)

const { REST, Routes } = require('discord.js');
const { TOKEN } = require('../config/constants');

/**
 * @returns {REST} REST client authenticated with the bot token
 */
function createCommandRest() {
    return new REST({ version: "10" }).setToken(TOKEN);
}

/**
 * @param {Array<SlashCommandBuilder>} commandBuilders - Command definitions
 * @returns {Array<object>} Request body for the registration endpoints
 */
function commandsToJson(commandBuilders) {
    return commandBuilders.map(builder => builder.toJSON());
}

/**
 * Removes all global commands, so guild-scoped commands are the single source
 * (no duplicates in the command picker).
 */
async function clearGlobalCommands(rest, applicationId) {
    await rest.put(Routes.applicationCommands(applicationId), { body: [] });
}

/**
 * Registers the commands for one guild (available immediately, unlike global ones).
 */
async function putGuildCommands(rest, applicationId, guildId, commandsJson) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commandsJson });
}

module.exports = {
    createCommandRest,
    commandsToJson,
    clearGlobalCommands,
    putGuildCommands
};
