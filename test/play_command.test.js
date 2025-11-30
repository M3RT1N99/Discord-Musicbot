
const assert = require('assert');
const fs = require('fs');
const { EventEmitter } = require('events');

// Mock child_process
const child_process = require('child_process');
child_process.spawn = (cmd, args) => {
    // console.log(`[TEST] Spawn: ${cmd} ${args.join(' ')}`);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};

    // Simulate output for search or info
    const isSearch = args.some(a => a.toString().startsWith('ytsearch'));

    if (isSearch) {
        setTimeout(() => {
            const result = {
                entries: [
                    { id: 'vid1', title: 'Result 1', url: 'http://youtube.com/watch?v=vid1', duration: 100 },
                    { id: 'vid2', title: 'Result 2', url: 'http://youtube.com/watch?v=vid2', duration: 200 }
                ]
            };
            proc.stdout.emit('data', JSON.stringify(result));
            proc.emit('close', 0);
        }, 10);
    } else if (args.includes('-J')) {
        // Info json
        setTimeout(() => {
            const info = {
                title: 'Test Video',
                duration: 120,
                webpage_url: args[args.length - 1]
            };
            proc.stdout.emit('data', JSON.stringify(info));
            proc.emit('close', 0);
        }, 10);
    } else {
        // Download
        setTimeout(() => {
            proc.emit('close', 0);
        }, 50);
    }
    return proc;
};

// Mock dependencies
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
    console.log("Running test: /play command");
    const guildId = "play_test_guild";

    // Mock fs
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => {
        if (p.includes("muse_downloads")) return true;
        return originalExistsSync(p);
    };

    // 1. Test Direct URL
    console.log("--- Test 1: Direct URL ---");
    let replyContent = "";
    const interaction1 = {
        isChatInputCommand: () => true,
        commandName: "play",
        guildId: guildId,
        user: { id: "user1" },
        member: { voice: { channel: { id: "voice1", guild: { voiceAdapterCreator: {} } } } },
        channel: { id: "text1", send: async () => {} },
        options: { getString: () => "http://youtube.com/watch?v=12345678901" }, // Valid 11 char ID
        createdTimestamp: Date.now(),
        deferReply: async () => {},
        editReply: async (msg) => { replyContent = msg; },
        reply: async (msg) => { replyContent = msg; },
        followUp: async (msg) => {
            // console.log("[TEST] FollowUp:", msg);
            if (msg.embeds) replyContent = msg.embeds[0].description;
            else replyContent = msg;
            return { delete: async () => {} };
        },
        guild: { voiceAdapterCreator: {} }
    };

    await muse.client.emit('interactionCreate', interaction1);
    await new Promise(r => setTimeout(r, 200));

    console.log("ReplyContent:", replyContent);

    // Check queue
    let queue = muse.guildQueues.get(guildId);
    assert.ok(queue, "Queue created");

    console.log("Interaction 1 finished.");

    // 2. Test Search
    console.log("--- Test 2: Search ---");
    replyContent = "";
    const interaction2 = {
        ...interaction1,
        options: { getString: () => "search query" },
        followUp: async (msg) => {
            // console.log("[TEST] Search FollowUp:", msg);
            if (typeof msg === 'string') replyContent = msg;
            else if (msg.content) replyContent = msg.content;
            return { id: 'msg1', delete: async () => {} };
        }
    };

    // Search returns results.
    await muse.client.emit('interactionCreate', interaction2);
    await new Promise(r => setTimeout(r, 100));

    console.log("ReplyContent Search:", replyContent);
    assert.ok(replyContent.includes("Suchergebnisse"), "Should show search results");

    console.log("Test Passed!");
    fs.existsSync = originalExistsSync;
}

runTest().catch(console.error);
