// src/commands/commandHandlers.js
// Command handler implementations for all slash commands

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { REST, Routes, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags: DjsMessageFlags } = require('discord.js');
const { createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { TOKEN, DOWNLOAD_DIR, MAPPING_DIR, LOCAL_AUDIO_EXTENSIONS, MAX_QUERY_LENGTH, SEARCH_CACHE_TIMEOUT, MAX_PENDING_CHOICES, MAX_SONGS_PER_QUEUE } = require('../config/constants');
const { joinVoiceChannelWithRetry } = require('../voice/VoiceManager');
const { downloadSingleTo, getVideoInfo, searchYouTubeVideos, getPlaylistEntries } = require('../download/ytdlp');
const { isValidMediaUrl, validateSearchQuery, sanitizeString, isInteractionValid, safeFollowUp } = require('../utils/validation');
const { isUrl, isYouTubePlaylistUrl, cleanYouTubeUrl, isRealPlaylist, cleanPlaylistUrl, hasVideoAndPlaylist } = require('../utils/urlCleaner');
const { truncateMessage } = require('../utils/formatting');
const DownloadProgressManager = require('../download/ProgressManager');
const { ensureNextTrackDownloadedAndPlay, skipCurrentTrack } = require('../queue/QueueManager');
const ui = require('../ui/messages');
const logger = require('../utils/logger');

// Pending playlist/song choices (short key -> { url, userId, createdAt })
const pendingPlaylistChoices = new Map();

// Cleanup expired playlist choices every 2 minutes (prevent memory leak)
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingPlaylistChoices) {
        if (now - (val.createdAt || 0) > 60000) {
            pendingPlaylistChoices.delete(key);
        }
    }
}, 120000).unref();

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

async function collectLocalAudioFiles(baseDir) {
    const files = [];

    async function walk(dir) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            if (!entry.isFile()) continue;

            const ext = path.extname(entry.name).toLowerCase();
            if (LOCAL_AUDIO_EXTENSIONS.includes(ext)) {
                files.push(fullPath);
            }
        }
    }

    await walk(baseDir);
    return files.sort((a, b) => path.relative(baseDir, a).localeCompare(path.relative(baseDir, b), undefined, { numeric: true, sensitivity: 'base' }));
}

// ---------------------------------------------------------------------------
// Helper: Download a single URL and play it (with progress embed)
// ---------------------------------------------------------------------------
async function handleSingleUrlPlay(context, url) {
    const { interaction, audioCache, guildQueues, backgroundDownloader } = context;
    const guildId = interaction.guildId;
    const queue = guildQueues.get(guildId);
    if (!queue) return;

    if (remoteSongCount(queue) >= MAX_SONGS_PER_QUEUE) {
        return await safeFollowUp(interaction, `❌ Queue-Limit erreicht (max. ${MAX_SONGS_PER_QUEUE} Songs).`);
    }

    // --- Cache hit ---
    if (audioCache.has(url)) {
        const filepath = audioCache.get(url);
        const entry = audioCache.getEntry(url);
        const title = entry?.meta?.title || path.basename(filepath);
        let duration = entry?.meta?.duration || 'unbekannt';

        queue.songs.push({ requesterId: interaction.user.id, title, filepath, url, duration });

        await safeFollowUp(interaction, { embeds: [ui.trackAddedEmbed({ title, url, duration, note: 'aus dem Cache — sofort verfügbar' })] });
        logger.info(`[CACHE HIT] ${title}`);

        // Fire-and-forget: the serialized chain may be busy with a long download —
        // never block the command response on it
        ensureNextTrackDownloadedAndPlay(guildId, audioCache);
        return;
    }

    // --- Fresh download ---
    logger.info(`[DOWNLOAD START] ${url}`);
    const tempFilename = `song_${Date.now()}_${randomUUID().slice(0, 8)}.opus`;
    const filepath = path.join(DOWNLOAD_DIR, tempFilename);

    let video;
    try {
        video = await getVideoInfo(url);
    } catch (err) {
        logger.error(`[VIDEO INFO ERROR] ${err.message}`);
        return await safeFollowUp(interaction, `❌ Konnte Video-Info nicht abrufen: ${err.message}`);
    }

    // Push the track synchronously so it keeps its queue position (a playlist's
    // remaining entries are pushed right after this call returns — the old
    // push-on-download-completion put track #1 behind the whole playlist).
    const track = { requesterId: interaction.user.id, title: video.title, filepath: null, url, duration: video.duration };
    queue.songs.push(track);

    const downloadMessages = [];
    let progressMsg = await safeFollowUp(interaction, { embeds: [ui.downloadProgressEmbed({ title: video.title, percent: 0 })] });
    downloadMessages.push(progressMsg);

    const progressManager = new DownloadProgressManager();
    const progressCb = (data) => {
        try {
            const parsed = progressManager.parseProgress(data);
            if (parsed && progressManager.shouldUpdate(parsed.percent)) {
                const embed = ui.downloadProgressEmbed({ title: video.title, percent: parsed.percent, speed: parsed.speed, eta: parsed.eta });
                if (progressMsg) progressMsg.edit({ embeds: [embed] }).catch(() => { });
            }
        } catch { }
    };

    const deleteDownloadMessages = () => {
        setTimeout(async () => {
            for (const msg of downloadMessages) {
                try { if (msg?.delete) await msg.delete(); } catch { }
            }
        }, 5000);
    };

    const dl = downloadSingleTo(filepath, url, progressCb);
    track._dlPromise = dl;
    dl
        .then(async () => {
            audioCache.set(url, filepath, { title: video.title, duration: video.duration });
            track.filepath = filepath;
            track._dlPromise = null;

            // Queue replaced/deleted during download (/stop, disconnect): the file
            // stays cached, but don't touch the new queue.
            if (guildQueues.get(guildId) !== queue) {
                logger.warn(`[DOWNLOAD] Queue gone for guild ${logger.guildTag(guildId)}, keeping track in cache only`);
                return;
            }

            const finishMsg = await safeFollowUp(interaction, { embeds: [ui.trackAddedEmbed({ title: video.title, url, duration: video.duration, note: 'Download abgeschlossen' })] });
            downloadMessages.push(finishMsg);
            deleteDownloadMessages();

            ensureNextTrackDownloadedAndPlay(guildId, audioCache);
        })
        .catch(async (err) => {
            track._dlPromise = null;
            logger.error(`[DOWNLOAD ERROR] ${err.message}`);

            const currentQueue = guildQueues.get(guildId);
            if (currentQueue === queue) {
                // Remove the failed track and kick the rest of the queue — without
                // this, a failed first playlist track left everything silently stuck.
                const i = queue.songs.indexOf(track);
                if (i !== -1) {
                    queue.songs.splice(i, 1);
                    queue._nextPrepared = false;
                }
                ensureNextTrackDownloadedAndPlay(guildId, audioCache);
            }

            const errorMsg = await safeFollowUp(interaction, `❌ Download fehlgeschlagen: ${err.message}`);
            downloadMessages.push(errorMsg);
            deleteDownloadMessages();
        });
}

// ============================= COMMAND HANDLERS =============================

/**
 * /play – URL, Playlist oder Suche
 */
async function handlePlayCommand(context) {
    const { interaction, audioCache, searchCache, rateLimiter, backgroundDownloader, guildQueues, createPlayerForGuild, createGuildQueue } = context;

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

    // Defer reply
    try {
        if (!interaction.replied && !interaction.deferred) await interaction.deferReply();
    } catch (err) {
        if (err.code === 10062) return; // Interaction expired
        throw err;
    }

    await safeFollowUp(interaction, `🔎 Verarbeite: ${truncateMessage(sanitizedQuery, 100)}`);

    // --- URL with both video + playlist? Ask user ---
    if (isUrl(sanitizedQuery) && hasVideoAndPlaylist(sanitizedQuery)) {
        const listParam = new URL(sanitizedQuery).searchParams.get('list');
        const isAutoMix = listParam && listParam.startsWith('RD');
        const playlistLabel = isAutoMix ? '📻 Auto-Mix abspielen' : '📋 Ganze Playlist';

        // Store URL with short key (customId max 100 chars)
        const choiceKey = randomUUID().slice(0, 8);

        // Evict oldest if at capacity
        if (pendingPlaylistChoices.size >= MAX_PENDING_CHOICES) {
            const oldestKey = pendingPlaylistChoices.keys().next().value;
            pendingPlaylistChoices.delete(oldestKey);
        }

        pendingPlaylistChoices.set(choiceKey, { url: sanitizedQuery, userId: interaction.user.id, createdAt: Date.now() });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`play_single|${choiceKey}`)
                .setLabel('🎵 Nur dieses Lied')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`play_playlist|${choiceKey}`)
                .setLabel(playlistLabel)
                .setStyle(ButtonStyle.Secondary)
        );

        const promptMsg = await safeFollowUp(interaction, {
            content: '🤔 Diese URL enthält ein Lied **und** eine Playlist. Was möchtest du abspielen?',
            components: [row]
        });

        // Auto-timeout: play single song after 15s if no interaction
        setTimeout(async () => {
            // Skip if user already made a choice (key was deleted on click)
            if (!pendingPlaylistChoices.has(choiceKey)) return;
            pendingPlaylistChoices.delete(choiceKey);

            try {
                const disabledRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('expired_single')
                        .setLabel('🎵 Nur dieses Lied (auto)')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('expired_playlist')
                        .setLabel(playlistLabel)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                );
                await promptMsg?.edit({ content: '⏱️ Keine Auswahl getroffen — spiele nur das Lied.', components: [disabledRow] }).catch(() => { });

                const singleUrl = cleanYouTubeUrl(sanitizedQuery);
                try {
                    await ensureQueueAndJoin(context);
                } catch (e) {
                    await safeFollowUp(interaction, `❌ ${e.message}`);
                    return;
                }
                await handleSingleUrlPlay(context, singleUrl || sanitizedQuery);
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

        let playlistInfo;
        try {
            playlistInfo = await getPlaylistEntries(sanitizedQuery);
        } catch (e) {
            logger.warn(`[PLAYLIST READ ERROR] ${e.message}`);
            return await safeFollowUp(interaction, `⚠️ Playlist konnte nicht geladen werden: ${e.message}`);
        }

        let { playlistTitle, entries } = playlistInfo;
        entries = entries.filter(e => e.url);
        if (!entries.length) return await safeFollowUp(interaction, 'Keine gültigen Einträge in der Playlist gefunden.');

        // index parameter support
        let startIndex = 0;
        try {
            const u = new URL(sanitizedQuery);
            if (u.searchParams.has('index')) {
                const idx = parseInt(u.searchParams.get('index'), 10);
                if (!isNaN(idx) && idx > 0 && idx <= entries.length) startIndex = idx - 1;
            }
        } catch { }

        // Reorder from startIndex
        const orderedEntries = [...entries.slice(startIndex), ...entries.slice(0, startIndex)];
        const [firstEntry, ...restEntries] = orderedEntries;

        // Progress message
        const progressMsg = await safeFollowUp(interaction, {
            embeds: [ui.playlistProgressEmbed({ playlistTitle, trackTitle: 'wird vorbereitet…', percent: 0, downloaded: 0, total: restEntries.length })]
        });
        queue.playlistProgressMsg = progressMsg;
        queue.lastProgressUpdate = Date.now();

        // Play first track immediately
        await handleSingleUrlPlay(context, firstEntry.url);

        // Add rest in background (respect queue size limit)
        let addedCount = 0;
        for (const e of restEntries) {
            if (remoteSongCount(queue) >= MAX_SONGS_PER_QUEUE) {
                logger.warn(`[QUEUE LIMIT][${interaction.guildId}] Queue full at ${MAX_SONGS_PER_QUEUE}, skipping remaining playlist entries`);
                break;
            }
            const track = {
                requesterId: interaction.user.id,
                title: e.title || 'Unbekannt',
                filepath: null,
                url: e.url,
                duration: e.duration || null,
                thumbnail: e.thumbnail || null,
                playlistTitle
            };
            queue.songs.push(track);
            backgroundDownloader.addToQueue(interaction.guildId, track);
            addedCount++;
        }

        await safeFollowUp(interaction, {
            embeds: [ui.playlistAddedEmbed({
                playlistTitle, added: addedCount, total: restEntries.length, startIndex,
                limitReached: addedCount < restEntries.length, maxSongs: MAX_SONGS_PER_QUEUE
            })]
        });

        // Kick playback even if the first track's info/download failed — otherwise
        // the freshly filled queue would sit silent until the next command.
        ensureNextTrackDownloadedAndPlay(interaction.guildId, audioCache);
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

    try {
        await ensureQueueAndJoin(context);
    } catch (e) {
        return await safeFollowUp(interaction, `❌ ${e.message}`);
    }

    return await handleSingleUrlPlay(context, cleanUrl);
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
    try {
        if (!interaction.replied && !interaction.deferred) await interaction.deferReply();
    } catch (err) {
        if (err.code === 10062) return;
        throw err;
    }

    await safeFollowUp(interaction, `🎵 Spiele: **${ui.mdEscape(selectedResult.title)}**`);

    try {
        await ensureQueueAndJoin(context);
    } catch (e) {
        return await safeFollowUp(interaction, `❌ ${e.message}`);
    }

    return await handleSingleUrlPlay(context, selectedResult.url);
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

    try {
        await ensureQueueAndJoin(context);
    } catch (e) {
        return await safeFollowUp(interaction, `❌ ${e.message}`);
    }

    return await handleSingleUrlPlay(context, selectedResult.url);
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
    queue.volume = clampedValue;

    // Apply volume to currently playing resource (Stability Pack 4.0 PCM)
    try {
        const res = queue.currentResource; // Use our tracked PCM resource
        if (res && res.volume) {
            res.volume.setVolume(clampedValue / 100);
        }
    } catch { }

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

    queue.shuffle = !queue.shuffle;
    queue._nextPrepared = false; // re-pick the next track under the new mode

    refreshNowPlayingCard(interaction.guildId, queue);
    await interaction.reply({ content: `🔀 Shuffle ${queue.shuffle ? 'aktiviert' : 'deaktiviert'}`, ephemeral: true });
}

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
 * /playcache – add all cached songs to queue
 */
async function handlePlaycacheCommand(context) {
    const { interaction, audioCache, guildQueues } = context;
    const memberVoice = interaction.member?.voice?.channel;

    if (!memberVoice) {
        return interaction.reply({ content: 'Du musst in einem Sprachkanal sein!', ephemeral: true });
    }

    const allEntries = audioCache.getAllEntries();
    if (allEntries.length === 0) {
        return interaction.reply({ content: '📦 Cache ist leer.', ephemeral: true });
    }

    await interaction.deferReply();

    let queue;
    try {
        queue = await ensureQueueAndJoin(context);
    } catch (e) {
        return interaction.editReply(`❌ Fehler beim Beitreten: ${e.message}`);
    }

    let addedCount = 0;
    for (const [key, val] of allEntries) {
        if (remoteSongCount(queue) >= MAX_SONGS_PER_QUEUE) break;
        if (fs.existsSync(val.filepath)) {
            queue.songs.push({
                requesterId: interaction.user.id,
                title: val.meta?.title || val.filename,
                filepath: val.filepath,
                url: key.startsWith('http') ? key : null,
                duration: val.meta?.duration,
                isCached: true
            });
            addedCount++;
        }
    }

    if (addedCount === 0) {
        return interaction.editReply('❌ Keine gültigen Dateien im Cache gefunden.');
    }

    let replyMsg = `✅ **${addedCount}** Songs aus dem Cache zur Queue hinzugefügt.`;
    if (remoteSongCount(queue) >= MAX_SONGS_PER_QUEUE) replyMsg += `\n⚠️ Queue-Limit erreicht (max. ${MAX_SONGS_PER_QUEUE}).`;
    await interaction.editReply(replyMsg);

    ensureNextTrackDownloadedAndPlay(interaction.guildId, audioCache);
}

/**
 * Counts queued songs that count toward MAX_SONGS_PER_QUEUE. Local mapping-folder
 * files (isLocalFile) are exempt — they need no download and use negligible memory,
 * so they neither hit the limit nor consume slots for remote/cached tracks.
 * @param {object} queue - Guild queue
 * @returns {number} Number of non-local (downloadable) songs in the queue
 */
function remoteSongCount(queue) {
    return queue.songs.reduce((n, s) => n + (s.isLocalFile ? 0 : 1), 0);
}

/**
 * /playchrist - add all local audio files from /mapping/christ to queue
 */
async function handlePlaychristCommand(context) {
    const { interaction, audioCache } = context;
    const memberVoice = interaction.member?.voice?.channel;

    if (!memberVoice) {
        return interaction.reply({ content: 'Du musst in einem Sprachkanal sein!', ephemeral: true });
    }

    await interaction.deferReply();

    let stat;
    try {
        stat = await fs.promises.stat(MAPPING_DIR);
    } catch {
        return interaction.editReply(`❌ Mapping-Ordner nicht gefunden: \`${MAPPING_DIR}\``);
    }

    if (!stat.isDirectory()) {
        return interaction.editReply(`❌ Mapping-Pfad ist kein Ordner: \`${MAPPING_DIR}\``);
    }

    let audioFiles;
    try {
        audioFiles = await collectLocalAudioFiles(MAPPING_DIR);
    } catch (err) {
        logger.error(`[PLAYCHRIST] Could not read mapping directory: ${err.message}`);
        return interaction.editReply('❌ Mapping-Ordner konnte nicht gelesen werden.');
    }

    if (audioFiles.length === 0) {
        return interaction.editReply(`📁 Keine Audiodateien im Mapping-Ordner gefunden. Unterstützt: ${LOCAL_AUDIO_EXTENSIONS.join(', ')}`);
    }

    let queue;
    try {
        queue = await ensureQueueAndJoin(context);
    } catch (e) {
        return interaction.editReply(`❌ Fehler beim Beitreten: ${e.message}`);
    }

    // Local mapping-folder files bypass MAX_SONGS_PER_QUEUE: no download, negligible memory per entry
    for (const filepath of audioFiles) {
        const relativePath = path.relative(MAPPING_DIR, filepath);
        const title = sanitizeString(path.basename(filepath, path.extname(filepath))) || path.basename(filepath);

        queue.songs.push({
            requesterId: interaction.user.id,
            title,
            filepath,
            url: null,
            duration: 'lokale Datei',
            isLocalFile: true,
            playlistTitle: 'mapping/christ',
            relativePath
        });
    }

    const replyMsg = `✅ **${audioFiles.length}** lokale Audiodateien aus \`${MAPPING_DIR}\` zur Queue hinzugefügt.`;

    await interaction.editReply(replyMsg);

    ensureNextTrackDownloadedAndPlay(interaction.guildId, audioCache);
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

        const rest = new REST({ version: '10' }).setToken(TOKEN);
        const commandsJson = commandBuilders.map(builder => builder.toJSON());

        // Clear global commands to keep guild-scoped commands as the single source.
        await rest.put(Routes.applicationCommands(interaction.client.application.id), { body: [] });
        await rest.put(Routes.applicationGuildCommands(interaction.client.application.id, interaction.guildId), { body: commandsJson });

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
    const choice = pendingPlaylistChoices.get(choiceKey);
    if (!choice) {
        return interaction.reply({ content: '⏱️ Diese Auswahl ist abgelaufen.', ephemeral: true });
    }

    const { url, userId } = choice;

    // Only the original user can click the buttons
    if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ Nur der ursprüngliche User kann diese Auswahl treffen.', ephemeral: true });
    }

    // Clean up
    pendingPlaylistChoices.delete(choiceKey);

    // Disable buttons
    const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('done_single')
            .setLabel('🎵 Nur dieses Lied')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId('done_playlist')
            .setLabel('📋 Ganze Playlist')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
    );

    if (action === 'play_single') {
        await interaction.update({
            content: '🎵 Spiele nur dieses Lied...',
            components: [disabledRow]
        });

        const singleUrl = cleanYouTubeUrl(url);
        try {
            await ensureQueueAndJoin(context);
        } catch (e) {
            return await safeFollowUp(interaction, `❌ ${e.message}`);
        }
        await handleSingleUrlPlay(context, singleUrl || url);

    } else if (action === 'play_playlist') {
        await interaction.update({
            content: '📋 Lade Playlist...',
            components: [disabledRow]
        });

        try {
            const queue = await ensureQueueAndJoin(context);
            let playlistInfo;
            try {
                playlistInfo = await getPlaylistEntries(url);
            } catch (e) {
                logger.warn(`[PLAYLIST READ ERROR] ${e.message}`);
                return await safeFollowUp(interaction, `⚠️ Playlist konnte nicht geladen werden: ${e.message}`);
            }

            let { playlistTitle, entries } = playlistInfo;
            entries = entries.filter(e => e.url);
            if (!entries.length) return await safeFollowUp(interaction, 'Keine gültigen Einträge in der Playlist gefunden.');

            let startIndex = 0;
            try {
                const u = new URL(url);
                if (u.searchParams.has('index')) {
                    const idx = parseInt(u.searchParams.get('index'), 10);
                    if (!isNaN(idx) && idx > 0 && idx <= entries.length) startIndex = idx - 1;
                }
            } catch { }

            const orderedEntries = [...entries.slice(startIndex), ...entries.slice(0, startIndex)];
            const [firstEntry, ...restEntries] = orderedEntries;

            const progressMsg = await safeFollowUp(interaction, {
                embeds: [ui.playlistProgressEmbed({ playlistTitle, trackTitle: 'wird vorbereitet…', percent: 0, downloaded: 0, total: restEntries.length })]
            });
            queue.playlistProgressMsg = progressMsg;
            queue.lastProgressUpdate = Date.now();

            await handleSingleUrlPlay(context, firstEntry.url);

            const { backgroundDownloader } = context;
            let addedCount = 0;
            for (const entry of restEntries) {
                if (remoteSongCount(queue) >= MAX_SONGS_PER_QUEUE) {
                    logger.warn(`[QUEUE LIMIT][${interaction.guildId}] Queue full at ${MAX_SONGS_PER_QUEUE}`);
                    break;
                }
                const track = {
                    requesterId: interaction.user.id,
                    title: entry.title || 'Unbekannt',
                    url: entry.url,
                    duration: entry.duration,
                    filepath: null,
                    playlistTitle
                };
                queue.songs.push(track);
                backgroundDownloader.addToQueue(interaction.guildId, track);
                addedCount++;
            }
            backgroundDownloader.processQueue();

            await safeFollowUp(interaction, {
                embeds: [ui.playlistAddedEmbed({
                    playlistTitle, added: addedCount, total: restEntries.length, startIndex,
                    limitReached: addedCount < restEntries.length, maxSongs: MAX_SONGS_PER_QUEUE
                })]
            });

            // Kick playback even if the first track's info/download failed
            ensureNextTrackDownloadedAndPlay(interaction.guildId, context.audioCache);

        } catch (e) {
            logger.error(`[PLAYLIST BUTTON] ${e.message}`);
            await safeFollowUp(interaction, `❌ Fehler: ${e.message}`);
        }
    }
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

    // AudioPlayerStatus already imported at top of file

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
            queue.volume = Math.min(100, (queue.volume || 50) + 10);
            try {
                const res = queue.currentResource;
                if (res && res.volume) res.volume.setVolume(queue.volume / 100);
            } catch { }
            break;
        }
        case 'np_voldn': {
            queue.volume = Math.max(0, (queue.volume || 50) - 10);
            try {
                const res = queue.currentResource;
                if (res && res.volume) res.volume.setVolume(queue.volume / 100);
            } catch { }
            break;
        }
        case 'np_shuffle': {
            queue.shuffle = !queue.shuffle;
            queue._nextPrepared = false; // re-pick the next track under the new mode
            break;
        }
        case 'np_loop': {
            // Cycle: off -> song -> queue -> off
            queue.loopMode = queue.loopMode === 'off' ? 'song' : queue.loopMode === 'song' ? 'queue' : 'off';
            break;
        }
        case 'np_savequeue': {
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
            const { AttachmentBuilder } = require('discord.js');
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
    handlePlayCommand,
    handleSelectCommand,
    handleSearchSelect,
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
    handlePlaychristCommand,
    handleRefreshCommand,
    handleClearcacheCommand,
    handleRepeatSingleCommand,
    handleRepeatCommand,
    handlePlaylistChoiceButton,
    handleNowPlayingButton
};
