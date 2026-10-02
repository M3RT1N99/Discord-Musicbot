// src/commands/library.js
// /playcache and /playlocalmusic: queue cached downloads or local library folders

const fs = require('fs');
const path = require('path');
const { LOCAL_AUDIO_EXTENSIONS, MAX_SONGS_PER_QUEUE } = require('../config/constants');
const { ensureNextTrackDownloadedAndPlay } = require('../queue/QueueManager');
const { remoteSongCount } = require('../queue/queueOps');
const { collectLocalAudioFiles } = require('../library/LocalMusicLibrary');
const { sanitizeString } = require('../utils/validation');
const { ensureQueueAndJoin } = require('./queueSession');
const logger = require('../utils/logger');

// Folder names are shown in `code spans` — a backtick inside would break them
const codeSpan = (text) => '`' + String(text).replace(/`/g, "'") + '`';

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
 * /playlocalmusic <ordner> – add all audio files of a library folder (and its
 * subfolders) to the queue. The folder comes from the autocomplete list.
 */
async function handlePlayLocalMusicCommand(context) {
    const { interaction, audioCache, localMusic } = context;
    const memberVoice = interaction.member?.voice?.channel;

    if (!memberVoice) {
        return interaction.reply({ content: 'Du musst in einem Sprachkanal sein!', ephemeral: true });
    }

    await interaction.deferReply();

    const requested = interaction.options.getString('ordner', true);
    let folder;
    try {
        folder = await localMusic.resolve(requested);
    } catch (err) {
        logger.error(`[PLAYLOCAL] Could not index music library: ${err.message}`);
        return interaction.editReply(`❌ Musikordner nicht gefunden: ${codeSpan(localMusic.rootDir)}`);
    }

    if (!folder) {
        return interaction.editReply(`❌ Ordner nicht gefunden: ${codeSpan(sanitizeString(requested).slice(0, 100))} — wähle einen Ordner aus der Liste.`);
    }

    let audioFiles;
    try {
        audioFiles = await collectLocalAudioFiles(folder.absPath);
    } catch (err) {
        logger.error(`[PLAYLOCAL] Could not read ${folder.relPath}: ${err.message}`);
        return interaction.editReply(`❌ Ordner ${codeSpan(folder.relPath)} konnte nicht gelesen werden.`);
    }

    if (audioFiles.length === 0) {
        return interaction.editReply(`📁 Keine Audiodateien in ${codeSpan(folder.relPath)} gefunden. Unterstützt: ${LOCAL_AUDIO_EXTENSIONS.join(', ')}`);
    }

    let queue;
    try {
        queue = await ensureQueueAndJoin(context);
    } catch (e) {
        return interaction.editReply(`❌ Fehler beim Beitreten: ${e.message}`);
    }

    // Local library files bypass MAX_SONGS_PER_QUEUE: no download, negligible memory per entry
    for (const filepath of audioFiles) {
        const title = sanitizeString(path.basename(filepath, path.extname(filepath))) || path.basename(filepath);

        queue.songs.push({
            requesterId: interaction.user.id,
            title,
            filepath,
            url: null,
            duration: 'lokale Datei',
            isLocalFile: true,
            playlistTitle: folder.relPath,
            relativePath: path.relative(localMusic.rootDir, filepath)
        });
    }

    await interaction.editReply(`✅ **${audioFiles.length}** lokale Audiodateien aus ${codeSpan(folder.relPath)} zur Queue hinzugefügt.`);

    ensureNextTrackDownloadedAndPlay(interaction.guildId, audioCache);
}

/**
 * Autocomplete for /playlocalmusic: library folders matching what the user typed.
 * Never throws — on any problem Discord just gets an empty list.
 */
async function handlePlayLocalMusicAutocomplete(context) {
    const { interaction, localMusic } = context;
    let choices = [];
    try {
        choices = await localMusic.autocomplete(interaction.options.getFocused());
    } catch (err) {
        logger.warn(`[PLAYLOCAL] Autocomplete failed: ${err.message}`);
    }
    await interaction.respond(choices).catch(() => { });
}

module.exports = {
    handlePlaycacheCommand,
    handlePlayLocalMusicCommand,
    handlePlayLocalMusicAutocomplete
};
