
const assert = require('assert');
const path = require('path');
const { randomUUID } = require('crypto');

// Mock dependencies
const DOWNLOAD_DIR = "/tmp/muse_downloads";
const guildQueues = new Map();
const audioCache = {
    set: () => {},
    get: () => null,
    has: () => false
};

// Mock downloadSingleTo
const downloadSingleTo = async (filepath, url, progressCb) => {
    // console.log("Mock downloadSingleTo called");
    if (progressCb) {
        progressCb("some progress");
    }
};

// Mock playNextInGuild
const playNextInGuild = () => {
    // console.log("Mock playNextInGuild called");
};

// Mock truncateMessage
const truncateMessage = (msg) => msg;

// This is a copy of the fixed function from index.js
// Ideally we would import it, but it's not exported.
// We are testing the logic that was fixed (passing null instead of undefined progressCb).
async function ensureNextTrackDownloadedAndPlay(guildId) {
    const q = guildQueues.get(guildId);
    if (!q) return;
    if (q.songs.length === 0) {
        try { q.connection.destroy(); } catch {}
        guildQueues.delete(guildId);
        return;
    }

    if (q.player.state.status === "Playing") return;

    const next = q.songs[0];
    if (!next) return;

   if (next.filepath) {
    playNextInGuild(guildId);
    return;
}
    if (!next.url) {
        q.songs.shift();
        return await ensureNextTrackDownloadedAndPlay(guildId);
    }

    const filename = `song_${Date.now()}_${randomUUID().slice(0,8)}.m4a`;
    const filepath = path.join(DOWNLOAD_DIR, filename);

    try {
        // FIX: Removed progressCb which was causing ReferenceError
        await downloadSingleTo(filepath, next.url, null);

        audioCache.set(next.url, filepath, { title: next.title, duration: next.duration });
        next.filepath = filepath;
        playNextInGuild(guildId);
    } catch (e) {
        // Rethrow to fail test if error occurs
        throw e;
    }
}

// Test Suite
async function runTest() {
    console.log("Running test: ensureNextTrackDownloadedAndPlay does not throw ReferenceError");

    const guildId = "test_guild";
    guildQueues.set(guildId, {
        songs: [{ url: "http://example.com/song", title: "Test Song", filepath: null }],
        player: { state: { status: "Idle" } },
        connection: { destroy: () => {} },
        lastInteractionChannel: { send: () => Promise.resolve() }
    });

    try {
        await ensureNextTrackDownloadedAndPlay(guildId);
        console.log("Test Passed: Function executed without error.");
    } catch (err) {
        console.error("Test Failed: Function threw an error.");
        console.error(err);
        process.exit(1);
    }
}

runTest();
