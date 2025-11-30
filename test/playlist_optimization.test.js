
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
                    // Case 3: Only ID provided (url missing)
                    { id: 'vid3', title: 'Video 3', duration: 300 },
                    // Case 4: No ID, but url is the ID (yt-dlp weirdness?)
                    { title: 'Video 4', url: 'vid4withoutid', duration: 400 }
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
    console.log("Running test: getPlaylistEntries robustness");

    const url = "https://www.youtube.com/playlist?list=PLtest";

    try {
        const result = await muse.getPlaylistEntries(url);
        console.log("Result entries count:", result.entries.length);

        // We want to capture as many as possible.
        // Currently:
        // 1 -> Recovered via ID.
        // 2 -> Valid.
        // 3 -> Recovered via ID.
        // 4 -> Fails? (No ID, URL is 'vid4withoutid').

        // If we fix case 4, we expect 4 entries.
        if (result.entries.length < 4) {
             console.log("FAIL: Not all entries recovered.");
             // process.exit(1); // Don't fail yet, I need to implement fix.
        }

        // Check contents
        const urls = result.entries.map(e => e.url);
        console.log("URLs:", urls);

        assert.ok(urls.includes("https://www.youtube.com/watch?v=vid1"));
        assert.ok(urls.includes("https://www.youtube.com/watch?v=vid2"));
        assert.ok(urls.includes("https://www.youtube.com/watch?v=vid3"));
        // We want this too:
        assert.ok(urls.includes("https://www.youtube.com/watch?v=vid4withoutid"));

        console.log("Test Passed!");

    } catch (e) {
        console.error("Test Error:", e);
        process.exit(1);
    }
}

runTest();
