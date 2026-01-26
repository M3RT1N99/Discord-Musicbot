// src/voice/VoiceManager.js
// Voice connection management

const { joinVoiceChannel } = require('@discordjs/voice');
const { JOIN_RETRIES } = require('../config/constants');

/**
 * Joins voice channel with retry logic
 * @param {VoiceChannel} voiceChannel - Voice channel to join
 * @param {number} retries - Number of retries (default: JOIN_RETRIES)
 * @returns {Promise<VoiceConnection>} Voice connection
 */
async function joinVoiceChannelWithRetry(voiceChannel, retries = JOIN_RETRIES) {
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator
            });

            console.log(`[VOICE] Joined channel: ${voiceChannel.name} in guild: ${voiceChannel.guild.name}`);
            return connection;
        } catch (e) {
            lastErr = e;
            console.warn(`[JOIN] Attempt ${attempt + 1}/${retries + 1} failed:`, e?.message || e);

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
        console.log("[VOICE] Left voice channel");
    } catch (e) {
        console.error("[VOICE] Error leaving channel:", e?.message || e);
    }
}

module.exports = {
    joinVoiceChannelWithRetry,
    leaveVoiceChannel
};
