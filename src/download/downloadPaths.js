// src/download/downloadPaths.js
// Naming contract for downloaded audio files in DOWNLOAD_DIR

const path = require('path');
const { randomUUID } = require('crypto');
const { DOWNLOAD_DIR } = require('../config/constants');

// Names produced by newDownloadPath(). AudioCache's orphan cleanup only ever
// deletes files matching this pattern, never foreign files in the directory.
const DOWNLOAD_FILE_PATTERN = /^song_\d+_[0-9a-f]{8}\./i;

/**
 * Returns a fresh, unique target path for a download:
 * DOWNLOAD_DIR/song_<ms>_<8 hex>.opus
 * @returns {string} File path inside DOWNLOAD_DIR
 */
function newDownloadPath() {
    return path.join(DOWNLOAD_DIR, `song_${Date.now()}_${randomUUID().slice(0, 8)}.opus`);
}

module.exports = {
    DOWNLOAD_FILE_PATTERN,
    newDownloadPath
};
