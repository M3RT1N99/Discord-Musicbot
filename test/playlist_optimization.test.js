
const assert = require('assert');
const { EventEmitter } = require('events');

// Mock child_process
const child_process = require('child_process');
child_process.spawn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};

    // Simulate output for playlist
    if (args.includes('--flat-playlist')) {
        setTimeout(() => {
            const result = {
                title: "Test Playlist",
                entries: [
                    { id: 'vid1', title: 'Video 1', url: 'https://www.youtube.com/watch?v=vid1', duration: 100 },
                    { id: 'vid2', title: 'Video 2', url: 'https://www.youtube.com/watch?v=vid2', duration: 200 }
                ]
            };
            proc.stdout.emit('data', JSON.stringify(result));
            proc.emit('close', 0);
        }, 10);
    } else if (args.includes('-J') && !args.includes('--flat-playlist')) {
        // This is the OLD behavior (full info)
        // We want to ensure the NEW behavior is used.
        // So we fail or return empty to see if it breaks?
        // Actually, the test calls getPlaylistEntries. We want it to use --flat-playlist.
        setTimeout(() => {
             // Return simplified info as if full info was requested but we want to fail if this is called?
             // Or just return same data.
             const result = {
                title: "Test Playlist Full",
                entries: [
                    { id: 'vid1', webpage_url: 'https://www.youtube.com/watch?v=vid1', title: 'Video 1', duration: 100 }
                ]
            };
            proc.stdout.emit('data', JSON.stringify(result));
            proc.emit('close', 0);
        }, 10);
    } else {
        setTimeout(() => {
            proc.emit('close', 0);
        }, 10);
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
            createAudioPlayer: () => ({ on: () => {} }),
            createAudioResource: () => ({ volume: { setVolume: () => {} } }),
            NoSubscriberBehavior: { Pause: 'pause' },
            AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' }
        }
    };
} catch (e) {}

const muse = require('../index.js');

async function runTest() {
    console.log("Running test: getPlaylistEntries with --flat-playlist");

    // We expect getPlaylistEntries to call spawn with --flat-playlist.
    // If we haven't modified index.js yet, it will call without it.

    const url = "https://www.youtube.com/playlist?list=PLtest";

    try {
        const result = await muse.getPlaylistEntries(url);
        console.log("Result:", result);

        // Assertions
        assert.strictEqual(result.playlistTitle, "Test Playlist");
        assert.strictEqual(result.entries.length, 2);
        assert.strictEqual(result.entries[0].title, "Video 1");

        // If it used full info (old code), it would match "Test Playlist Full" mock.
        // If we want to verify the optimization, we should ensure the title is "Test Playlist"
        // which comes from the --flat-playlist mock branch.

        if (result.playlistTitle === "Test Playlist") {
            console.log("Optimization active: --flat-playlist used.");
        } else {
            console.log("Old behavior active: full info used.");
        }

    } catch (e) {
        console.error("Test Error:", e);
        process.exit(1);
    }
}

runTest();
