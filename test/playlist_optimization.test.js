
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
                    // Case 1: ID provided, URL is just the ID (invalid URL)
                    { id: 'vid1', title: 'Video 1', url: 'vid1', duration: 100 },
                    // Case 2: Full URL provided
                    { id: 'vid2', title: 'Video 2', url: 'https://www.youtube.com/watch?v=vid2', duration: 200 },
                    // Case 3: Only ID provided (url missing) - yt-dlp might do this?
                    // Usually url is present. But let's test robust ID handling.
                    { id: 'vid3', title: 'Video 3', duration: 300 }
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

const muse = require('../index.js');

async function runTest() {
    console.log("Running test: getPlaylistEntries with --flat-playlist and ID handling");

    const url = "https://www.youtube.com/playlist?list=PLtest";

    try {
        const result = await muse.getPlaylistEntries(url);
        console.log("Result entries count:", result.entries.length);

        // We expect all 3 videos to be present if handled correctly.
        // Currently (before fix), Video 1 (url='vid1') and Video 3 (no url) will be filtered out.
        // Only Video 2 has valid URL.

        if (result.entries.length === 1) {
            console.log("FAIL: Only 1 entry found. ID handling is broken.");
            process.exit(1);
        }

        assert.strictEqual(result.entries.length, 3, "Should have 3 entries");
        assert.strictEqual(result.entries[0].url, "https://www.youtube.com/watch?v=vid1");
        assert.strictEqual(result.entries[2].url, "https://www.youtube.com/watch?v=vid3");

        console.log("Test Passed!");

    } catch (e) {
        console.error("Test Error:", e);
        process.exit(1);
    }
}

runTest();
