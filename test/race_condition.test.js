
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const child_process = require('child_process');

// Mock spawn
const originalSpawn = child_process.spawn;
let downloadCallCount = 0;

child_process.spawn = (command, args, options) => {
    // Only mock yt-dlp
    if (command.includes('yt-dlp')) {
        const isDownload = args.includes('-o'); // Heuristic for download vs info
        if (isDownload) {
            downloadCallCount++;
            // console.log(`[TEST] Download started (Count: ${downloadCallCount})`);
        }

        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = () => { };

        // Delay close to simulate download time
        setTimeout(() => {
            proc.emit('close', 0);
        }, 50);

        return proc;
    }
    return originalSpawn(command, args, options);
};

// Mock module for imports
const Module = require('module');
const originalRequire = Module.prototype.require;

try {
    const voicePath = require.resolve('@discordjs/voice');
    require.cache[voicePath] = {
        id: voicePath,
        filename: voicePath,
        loaded: true,
        exports: {
            joinVoiceChannel: () => ({ subscribe: () => { } }),
            createAudioPlayer: () => ({
                on: () => { },
                state: { status: 'Idle' },
                play: () => { }
            }),
            createAudioResource: () => ({ volume: { setVolume: () => { } } }),
            NoSubscriberBehavior: { Pause: 'pause' },
            AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' }
        }
    };
} catch (e) { }

// Import
const muse = require('../src/index.js');

async function runTest() {
    console.log("Running test: Race Condition in ensureNextTrackDownloadedAndPlay");

    const guildId = "race_guild";

    // Setup queue with NO songs initially
    const queue = {
        songs: [],
        player: {
            state: { status: "Idle" },
            play: () => { }
        },
        connection: { destroy: () => { } },
        lastInteractionChannel: { send: () => Promise.resolve() },
        volume: 50
    };
    muse.guildQueues.set(guildId, queue);

    // Mock fs
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => {
        if (p.includes("muse_downloads")) return true;
        return originalExistsSync(p);
    };

    // Add two songs to the queue almost simultaneously and trigger ensure...
    const song1 = { url: "http://example.com/1", title: "Song 1", filepath: null };
    const song2 = { url: "http://example.com/2", title: "Song 2", filepath: null };

    queue.songs.push(song1);
    const p1 = muse.ensureNextTrackDownloadedAndPlay(guildId);

    queue.songs.push(song2);
    const p2 = muse.ensureNextTrackDownloadedAndPlay(guildId); // Called while p1 is "downloading"

    await Promise.all([p1, p2]);

    console.log(`Download called ${downloadCallCount} times.`);

    // If logic is correct, it should download Song 1 once.
    // If race condition exists, it might see Song 1 twice (since it's at index 0)
    // and try to download it twice before the first one finishes?
    // Wait, ensureNextTrackDownloadedAndPlay peeks index 0.
    // Call 1: Sees Song 1. Starts download.
    // Call 2: Sees Song 1. Starts download.
    // Both finish.
    // Call 1 -> playNextInGuild -> shifts Song 1.
    // Call 2 -> playNextInGuild -> shifts Song 2.
    // So Song 1 is downloaded TWICE.

    assert.strictEqual(downloadCallCount, 1, "Should only download the first song once when called concurrently");

    console.log("Test Passed!");

    // Cleanup
    child_process.spawn = originalSpawn;
    fs.existsSync = originalExistsSync;
}

runTest().catch(err => {
    console.error("Test Failed:", err.message);
    process.exit(1);
});
