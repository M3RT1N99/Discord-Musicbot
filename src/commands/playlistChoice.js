// src/commands/playlistChoice.js
// Buttons of the "song or playlist?" prompt

const { safeFollowUp } = require('../utils/validation');
const { cleanYouTubeUrl } = require('../utils/urlCleaner');
const { getPendingChoice, deletePendingChoice } = require('./pendingChoices');
const { enqueuePlaylist } = require('./playlistIntake');
const { ensureQueueAndJoin } = require('./queueSession');
const { joinAndPlaySingle } = require('./singleTrack');
const ui = require('../ui/messages');
const logger = require('../utils/logger');

/**
 * Queued track for an entry of a playlist picked via the choice button
 */
function choiceEntryTrack(entry, playlistTitle, requesterId) {
    return {
        requesterId,
        title: entry.title || 'Unbekannt',
        url: entry.url,
        duration: entry.duration,
        filepath: null,
        playlistTitle
    };
}

/**
 * Handle button interaction from playlist/song choice prompt
 */
async function handlePlaylistChoiceButton(context) {
    const { interaction } = context;
    const customId = interaction.customId;
    const parts = customId.split('|');
    if (parts.length < 2) return;

    const [action, choiceKey] = parts;

    // Look up stored choice
    const choice = getPendingChoice(choiceKey);
    if (!choice) {
        return interaction.reply({ content: '⏱️ Diese Auswahl ist abgelaufen.', ephemeral: true });
    }

    const { url, userId } = choice;

    // Only the original user can click the buttons
    if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ Nur der ursprüngliche User kann diese Auswahl treffen.', ephemeral: true });
    }

    // Clean up
    deletePendingChoice(choiceKey);

    if (action === 'play_single') {
        await interaction.update({
            content: '🎵 Spiele nur dieses Lied...',
            components: [ui.songOrPlaylistDoneRow()]
        });

        await joinAndPlaySingle(context, cleanYouTubeUrl(url) || url);

    } else if (action === 'play_playlist') {
        await interaction.update({
            content: '📋 Lade Playlist...',
            components: [ui.songOrPlaylistDoneRow()]
        });

        try {
            const queue = await ensureQueueAndJoin(context);
            await enqueuePlaylist(context, queue, url, { makeTrack: choiceEntryTrack });
        } catch (e) {
            logger.error(`[PLAYLIST BUTTON] ${e.message}`);
            await safeFollowUp(interaction, `❌ Fehler: ${e.message}`);
        }
    }
}

module.exports = {
    handlePlaylistChoiceButton
};
