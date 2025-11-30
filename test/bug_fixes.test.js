
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// Mock child_process BEFORE requiring index.js
const child_process = require('child_process');
const originalSpawn = child_process.spawn;

// Mock spawn to return a fake process
let spawnMockCalled = false;
let spawnArgs = [];
let spawnOptions = {};

child_process.spawn = (command, args, options) => {
    spawnMockCalled = true;
    spawnArgs = args;
    spawnOptions = options;
    // console.log(`[TEST] Mock spawn called with: ${command} ${args.join(' ')}`);

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};

    // Simulate successful execution asynchronously
    setTimeout(() => {
        proc.emit('close', 0);
    }, 50);

    return proc;
};

// Mock @discordjs/voice BEFORE requiring index.js
const Module = require('module');
const originalRequire = Module.prototype.require;

// We need to use a proxy or just pre-load the module in cache if possible.
// But node modules are cached by filename.
// A simpler way is to rely on 'mock-require' or just overwrite the require cache if we knew the path.
// But we don't know the exact path of @discordjs/voice.

// Let's try to populate require.cache for '@discordjs/voice' if we can resolve it.
try {
    const voicePath = require.resolve('@discordjs/voice');
    require.cache[voicePath] = {
        id: voicePath,
        filename: voicePath,
        loaded: true,
        exports: {
            joinVoiceChannel: () => ({ subscribe: () => {} }),
            createAudioPlayer: () => ({ on: () => {} }),
            createAudioResource: () => ({ volume: { setVolume: () => {} } }),
            NoSubscriberBehavior: { Pause: 'pause' },
            AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' }
        }
    };
} catch (e) {
    console.log("[TEST] Could not resolve @discordjs/voice, mocking might fail if not found.");
}

// Import the module
const muse = require('../index.js');

async function runTest() {
    console.log("Running test: ensureNextTrackDownloadedAndPlay (real function) integration");

    const guildId = "test_guild_real";
    let playCalled = false;

    // Setup initial state
    const queue = {
        songs: [{
            url: "http://example.com/song",
            title: "Test Song",
            filepath: null,
            duration: 120,
            requesterId: "user1"
        }],
        player: {
            state: { status: "Idle", resource: { volume: { setVolume: () => {} } } },
            play: (resource) => {
                console.log("[TEST] Player.play called");
                playCalled = true;
            }
        },
        connection: { destroy: () => {} },
        lastInteractionChannel: { send: () => Promise.resolve() },
        volume: 50
    };

    muse.guildQueues.set(guildId, queue);

    // Mock fs.existsSync to pretend download worked
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => {
        if (p.includes("muse_downloads")) return true;
        return originalExistsSync(p);
    };

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (p, enc) => {
        if (p.includes(".cache_index.json")) return "[]";
        return originalReadFileSync(p, enc);
    };

    try {
        await muse.ensureNextTrackDownloadedAndPlay(guildId);

        console.log("Function executed.");

        // Verifications
        assert.ok(spawnMockCalled, "spawn should have been called");
        assert.strictEqual(spawnOptions.shell, false, "spawn should be called with shell: false");
        assert.ok(playCalled, "player.play should have been called");

        const q = muse.guildQueues.get(guildId);
        if (q) {
             assert.strictEqual(q.songs.length, 0, "Song should have been removed from queue after playing");
        }

        console.log("Test Passed!");

    } catch (err) {
        console.error("Test Failed:", err);
        process.exit(1);
    } finally {
        // Cleanup
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        child_process.spawn = originalSpawn;
    }
}

runTest();
