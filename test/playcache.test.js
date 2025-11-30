
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Mock child_process BEFORE requiring index.js
const child_process = require('child_process');
child_process.spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    // Auto-close
    setTimeout(() => proc.emit('close', 0), 10);
    return proc;
};

// Mock module imports
const Module = require('module');
try {
    const voicePath = require.resolve('@discordjs/voice');
    require.cache[voicePath] = {
        id: voicePath,
        filename: voicePath,
        loaded: true,
        exports: {
            joinVoiceChannel: () => ({ subscribe: () => {} }),
            createAudioPlayer: () => ({
                on: () => {},
                state: { status: 'Idle' },
                play: () => {}
            }),
            createAudioResource: () => ({ volume: { setVolume: () => {} } }),
            NoSubscriberBehavior: { Pause: 'pause' },
            AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' }
        }
    };
} catch (e) {}

const muse = require('../index.js');

async function runTest() {
    console.log("Running test: /playcache command logic");

    const guildId = "cache_test_guild";

    // Manually populate cache
    const cacheUrl = "http://example.com/cache1";
    const cacheFile = "/tmp/muse_downloads/test_cache_song.m4a";

    muse.audioCache.set(cacheUrl, cacheFile, { title: "Cached Song", duration: 120 });

    // Mock fs.existsSync to return true for our fake file
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => {
        if (p === cacheFile) return true;
        if (p === "/tmp/file2") return true;
        if (p.includes("muse_downloads")) return true;
        return originalExistsSync(p);
    };

    // Simulate interaction
    let replyContent = "";
    let deferred = false;
    const interaction = {
        isChatInputCommand: () => true,
        commandName: "playcache",
        guildId: guildId,
        user: { id: "user1" },
        member: { voice: { channel: { id: "voice1", guild: { voiceAdapterCreator: {} } } } },
        channel: {
            id: "text1",
            send: async (msg) => { /* console.log("[TEST] Channel.send:", msg); */ }
        },
        createdTimestamp: Date.now(),
        deferReply: async () => { deferred = true; },
        editReply: async (msg) => {
            replyContent = typeof msg === 'string' ? msg : msg.content;
        },
        reply: async (msg) => {
            replyContent = typeof msg === 'string' ? msg : msg.content;
        },
        guild: { voiceAdapterCreator: {} }
    };

    await muse.client.emit('interactionCreate', interaction);

    // Wait a bit for async stuff
    await new Promise(r => setTimeout(r, 200));

    console.log("Reply:", replyContent);
    assert.ok(replyContent && replyContent.includes("Songs aus dem Cache"), "Should verify added songs");

    // Verify queue
    const queue = muse.guildQueues.get(guildId);
    assert.ok(queue, "Queue should exist");

    // Add another
    muse.audioCache.set("http://url2", "/tmp/file2", { title: "Song 2" });
    // Update mock for new file
    fs.existsSync = (p) => {
        if (p === cacheFile || p === "/tmp/file2") return true;
        if (p.includes("muse_downloads")) return true;
        return originalExistsSync(p);
    };

    // Run command again
    await muse.client.emit('interactionCreate', interaction);
    await new Promise(r => setTimeout(r, 200));

    console.log("Reply 2:", replyContent);
    assert.ok(replyContent.includes("Songs aus dem Cache"), "Should confirm added songs");

    console.log("Test Passed!");
    fs.existsSync = originalExistsSync;
}

runTest().catch((err) => {
    console.error("Test Failed:", err);
    process.exit(1);
});
