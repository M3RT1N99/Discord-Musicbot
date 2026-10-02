// src/commands/library.js
// /playcache and /playchrist: queue cached downloads or local audio files

const fs = require('fs');
const path = require('path');
const { MAPPING_DIR, LOCAL_AUDIO_EXTENSIONS, MAX_SONGS_PER_QUEUE } = require('../config/constants');
const { ensureNextTrackDownloadedAndPlay } = require('../queue/QueueManager');
const { remoteSongCount } = require('../queue/queueOps');
const { sanitizeString } = require('../utils/validation');
const { ensureQueueAndJoin } = require('./queueSession');
const logger = require('../utils/logger');

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

module.exports = {
    handlePlaycacheCommand,
    handlePlaychristCommand
};
