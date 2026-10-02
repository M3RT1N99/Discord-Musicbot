// src/commands/queueSession.js
// Joins the user's voice channel and creates the guild queue on first use

const { joinVoiceChannelWithRetry } = require('../voice/VoiceManager');

// ---------------------------------------------------------------------------
// Helper: Ensure a voice queue exists, joining the user's channel if needed
// ---------------------------------------------------------------------------
async function ensureQueueAndJoin(context) {
    const { interaction, audioCache, guildQueues, createPlayerForGuild, createGuildQueue } = context;
    const guildId = interaction.guildId;
    const memberVoice = interaction.member?.voice?.channel;
    let queue = guildQueues.get(guildId);

    if (!queue) {
        if (!memberVoice) throw new Error('Du musst in einem Sprachkanal sein!');

        const connection = await joinVoiceChannelWithRetry(memberVoice);
        const player = createPlayerForGuild(guildId, connection);
        connection.subscribe(player);
        queue = createGuildQueue(guildId, connection, player, interaction.channel);
        queue.audioCache = audioCache; // Store ref so Idle handler can use it
    } else {
        queue.lastInteractionChannel = interaction.channel;
        if (audioCache && !queue.audioCache) queue.audioCache = audioCache;
    }
    return queue;
}

module.exports = {
    ensureQueueAndJoin
};
