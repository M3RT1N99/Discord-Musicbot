// src/commands/play.js
// /play (URL, playlist or search), /select and the search result picker

const { MAX_QUERY_LENGTH } = require('../config/constants');
const { searchYouTubeVideos } = require('../download/ytdlp');
const { isValidMediaUrl, validateSearchQuery, sanitizeString, isInteractionValid, safeFollowUp } = require('../utils/validation');
const { isUrl, isYouTubePlaylistUrl, cleanYouTubeUrl, isRealPlaylist, hasVideoAndPlaylist } = require('../utils/urlCleaner');
const { truncateMessage } = require('../utils/formatting');
const { createPendingChoice, deletePendingChoice } = require('./pendingChoices');
const { enqueuePlaylist } = require('./playlistIntake');
const { ensureQueueAndJoin } = require('./queueSession');
const { joinAndPlaySingle } = require('./singleTrack');
const ui = require('../ui/messages');

/**
 * Defers the reply unless the interaction was already acknowledged.
 * @param {object} interaction - Discord interaction
 * @returns {Promise<boolean>} false if the interaction already expired (10062)
 */
async function deferReplyOnce(interaction) {
    try {
        if (!interaction.replied && !interaction.deferred) await interaction.deferReply();
        return true;
    } catch (err) {
        if (err.code === 10062) return false; // Interaction expired
        throw err;
    }
}

/**
 * Queued track for an entry of a playlist opened via /play
 * (keeps the entry thumbnail for the Now Playing card)
 */
function playlistEntryTrack(e, playlistTitle, requesterId) {
    return {
        requesterId,
        title: e.title || 'Unbekannt',
        filepath: null,
        url: e.url,
        duration: e.duration || null,
        thumbnail: e.thumbnail || null,
        playlistTitle
    };
}

/**
 * /play – URL, Playlist oder Suche
 */
async function handlePlayCommand(context) {
    const { interaction, searchCache, rateLimiter } = context;

    if (!isInteractionValid(interaction)) return;

    const memberVoice = interaction.member?.voice?.channel;
    if (!memberVoice) {
        return interaction.reply({ content: 'Du musst in einem Sprachkanal sein!', ephemeral: true });
    }

    const rawQuery = interaction.options.getString('query', true);

    // Rate-Limit check
    if (!rateLimiter.check(interaction.user.id)) {
        return interaction.reply({ content: '⚠️ Du hast zu viele Downloads angefragt. Warte eine Minute.', ephemeral: true });
    }

    // Input validation
    const sanitizedQuery = sanitizeString(rawQuery);
    if (!sanitizedQuery) {
        return interaction.reply({ content: '❌ Eingabe enthält ungültige Zeichen.', ephemeral: true });
    }
    if (sanitizedQuery.length > MAX_QUERY_LENGTH) {
        return interaction.reply({ content: `❌ Eingabe zu lang (max. ${MAX_QUERY_LENGTH} Zeichen).`, ephemeral: true });
    }

    if (!(await deferReplyOnce(interaction))) return;

    await safeFollowUp(interaction, `🔎 Verarbeite: ${truncateMessage(sanitizedQuery, 100)}`);

    // --- URL with both video + playlist? Ask user ---
    if (isUrl(sanitizedQuery) && hasVideoAndPlaylist(sanitizedQuery)) {
        const listParam = new URL(sanitizedQuery).searchParams.get('list');
        const isAutoMix = listParam && listParam.startsWith('RD');
        const playlistLabel = isAutoMix ? '📻 Auto-Mix abspielen' : '📋 Ganze Playlist';

        const choiceKey = createPendingChoice(sanitizedQuery, interaction.user.id);

        const promptMsg = await safeFollowUp(interaction, {
            content: '🤔 Diese URL enthält ein Lied **und** eine Playlist. Was möchtest du abspielen?',
            components: [ui.songOrPlaylistRow(choiceKey, playlistLabel)]
        });

        // Auto-timeout: play single song after 15s if no interaction
        setTimeout(async () => {
            // Skip if user already made a choice (key was deleted on click)
            if (!deletePendingChoice(choiceKey)) return;

            try {
                await promptMsg?.edit({ content: '⏱️ Keine Auswahl getroffen — spiele nur das Lied.', components: [ui.songOrPlaylistExpiredRow(playlistLabel)] }).catch(() => { });
                await joinAndPlaySingle(context, cleanYouTubeUrl(sanitizedQuery) || sanitizedQuery);
            } catch { }
        }, 15000);

        return; // Wait for button interaction
    }

    // --- Playlist ---
    if (isYouTubePlaylistUrl(sanitizedQuery) && isRealPlaylist(sanitizedQuery)) {
        let queue;
        try {
            queue = await ensureQueueAndJoin(context);
        } catch (e) {
            return await safeFollowUp(interaction, `❌ ${e.message}`);
        }

        await enqueuePlaylist(context, queue, sanitizedQuery, {
            makeTrack: playlistEntryTrack,
            limitLogSuffix: ', skipping remaining playlist entries'
        });
        return;
    }

    // --- Search ---
    if (!isUrl(sanitizedQuery)) {
        if (!validateSearchQuery(sanitizedQuery)) {
            return await safeFollowUp(interaction, '❌ Ungültige Suchanfrage. Verwende nur alphanumerische Zeichen und Leerzeichen.');
        }

        await safeFollowUp(interaction, '🔍 Suche nach Videos...');
        let searchResults;
        const searchStart = Date.now();
        try {
            searchResults = await searchYouTubeVideos(sanitizedQuery, 10);
        } catch (e) {
            const errorMsg = e.message.includes('timeout')
                ? '❌ Suche dauerte zu lange. Versuche einen spezifischeren Suchbegriff.'
                : `❌ Suche fehlgeschlagen: ${e.message}`;
            return await safeFollowUp(interaction, errorMsg);
        }

        if (!searchResults || searchResults.length === 0) {
            return await safeFollowUp(interaction, '❌ Keine Ergebnisse gefunden.');
        }

        const searchMessage = await safeFollowUp(interaction, ui.searchResultsMessage(searchResults, interaction.user.id));

        searchCache.set(interaction.user.id, {
            results: searchResults,
            timestamp: searchStart,
            messageId: searchMessage?.id,
            channelId: interaction.channel?.id
        });
        return;
    }

    // --- Direct URL ---
    let cleanUrl = cleanYouTubeUrl(sanitizedQuery);
    if (!cleanUrl) {
        if (isValidMediaUrl(sanitizedQuery)) {
            cleanUrl = sanitizedQuery;
        } else {
            return await safeFollowUp(interaction, '❌ Ungültige URL.');
        }
    }

    return await joinAndPlaySingle(context, cleanUrl);
}

/**
 * /select – Suchergebnis auswählen
 */
async function handleSelectCommand(context) {
    const { interaction, searchCache } = context;

    if (!isInteractionValid(interaction)) return;

    const number = interaction.options.getInteger('number');
    const userId = interaction.user.id;
    const cached = searchCache.get(userId);

    if (!cached) {
        return interaction.reply('❌ Keine Suchergebnisse gefunden. Verwende zuerst `/play <suchbegriff>`.');
    }

    if (number < 1 || number > cached.results.length) {
        return interaction.reply(`❌ Ungültige Nummer. Wähle zwischen 1 und ${cached.results.length}.`);
    }

    const selectedResult = cached.results[number - 1];

    // Delete search results message
    if (cached.messageId && cached.channelId) {
        try {
            const channel = interaction.client.channels.cache.get(cached.channelId);
            if (channel) {
                const message = await channel.messages.fetch(cached.messageId);
                if (message) await message.delete();
            }
        } catch { }
    }

    searchCache.delete(userId);

    // Defer & play
    if (!(await deferReplyOnce(interaction))) return;

    await safeFollowUp(interaction, `🎵 Spiele: **${ui.mdEscape(selectedResult.title)}**`);

    return await joinAndPlaySingle(context, selectedResult.url);
}

/**
 * Select menu on the search results message: pick and play a result directly
 */
async function handleSearchSelect(context) {
    const { interaction, searchCache } = context;
    const ownerId = interaction.customId.split('|')[1];

    if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ Das ist nicht deine Suche — starte selbst eine mit `/play`.', ephemeral: true });
    }

    // Reject picks from an outdated search message (a newer search replaced it)
    const cached = searchCache.get(ownerId);
    if (!cached || (cached.messageId && interaction.message?.id !== cached.messageId)) {
        return interaction.reply({ content: '❌ Diese Suche ist abgelaufen. Starte eine neue mit `/play <suchbegriff>`.', ephemeral: true });
    }

    const number = parseInt(interaction.values[0], 10);
    const selectedResult = cached.results[number - 1];
    if (!selectedResult) {
        return interaction.reply({ content: '❌ Ungültige Auswahl.', ephemeral: true });
    }

    searchCache.delete(ownerId);

    // Turn the search message into the confirmation. This acknowledges the
    // interaction AND sets interaction.replied, so later safeFollowUp calls go
    // to the channel (a deferUpdate here would route them into editReply on
    // this message instead — and lose them if it were deleted).
    await interaction.update({
        content: `🎵 Spiele: **${ui.mdEscape(selectedResult.title)}**`,
        embeds: [],
        components: []
    }).catch(() => { });

    return await joinAndPlaySingle(context, selectedResult.url);
}

module.exports = {
    handlePlayCommand,
    handleSelectCommand,
    handleSearchSelect
};
