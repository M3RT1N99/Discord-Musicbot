// src/voice/VoiceManager.js
// Voice connection management

const { joinVoiceChannel } = require('@discordjs/voice');
const { ChannelType, PermissionsBitField } = require('discord.js');
const { JOIN_RETRIES } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * Ensures the bot becomes a speaker on a stage channel (bots join as suppressed audience).
 * Retries a few times because the bot's voice state may not exist right after joining.
 * Never throws — logs a warning if the bot lacks stage moderator permissions.
 * @param {StageChannel} voiceChannel - Stage channel the bot joined
 */
async function ensureStageSpeaker(voiceChannel) {
    const maxAttempts = 3;
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const voiceState = voiceChannel.guild.members.me?.voice;
            if (!voiceState || voiceState.channelId !== voiceChannel.id) {
                throw new Error('Voice state not available yet');
            }
            await voiceState.setSuppressed(false);
            logger.info(`[VOICE] Unsuppressed on stage channel: ${voiceChannel.name}`);
            return;
        } catch (e) {
            lastErr = e;
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    logger.warn(`[VOICE] Could not unsuppress on stage channel "${voiceChannel.name}": ${lastErr?.message || lastErr} — bot must be a stage moderator (MuteMembers permission) to be audible.`);
}

/**
 * Joins voice channel with retry logic
 * @param {VoiceChannel} voiceChannel - Voice channel to join
 * @param {number} retries - Number of retries (default: JOIN_RETRIES)
 * @returns {Promise<VoiceConnection>} Voice connection
 */
async function joinVoiceChannelWithRetry(voiceChannel, retries = JOIN_RETRIES) {
    // Check bot permissions before attempting to join
    const permissions = voiceChannel.permissionsFor(voiceChannel.guild.members.me);
    if (permissions && !permissions.has(PermissionsBitField.Flags.Connect)) {
        throw new Error('Keine Berechtigung dem Sprachkanal beizutreten.');
    }
    if (permissions && !permissions.has(PermissionsBitField.Flags.Speak)) {
        throw new Error('Keine Berechtigung im Sprachkanal zu sprechen.');
    }

    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator
            });

            logger.info(`[VOICE] Joined channel: ${voiceChannel.name} in guild: ${voiceChannel.guild.name}`);

            // Stage channels: bot joins as suppressed audience — request speaker (non-blocking)
            if (voiceChannel.type === ChannelType.GuildStageVoice) {
                ensureStageSpeaker(voiceChannel).catch(e =>
                    logger.warn(`[VOICE] Stage unsuppress error: ${e?.message || e}`)
                );
            }

            return connection;
        } catch (e) {
            lastErr = e;
            logger.warn(`[JOIN] Attempt ${attempt + 1}/${retries + 1} failed: ${e?.message || e}`);

            // Small delay before retry
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 700));
            }
        }
    }

    throw lastErr || new Error("Failed to join voice channel");
}

/**
 * Leaves voice channel and cleans up
 * @param {VoiceConnection} connection - Voice connection to destroy
 */
function leaveVoiceChannel(connection) {
    try {
        connection.destroy();
        logger.info("[VOICE] Left voice channel");
    } catch (e) {
        logger.error(`[VOICE] Error leaving channel: ${e?.message || e}`);
    }
}

module.exports = {
    joinVoiceChannelWithRetry,
    leaveVoiceChannel
};
