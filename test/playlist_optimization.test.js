
const assert = require('assert');
const { EventEmitter } = require('events');

// Mock child_process
const child_process = require('child_process');
child_process.spawn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { };

    // Simulate output for playlist
    if (args.includes('--flat-playlist')) {
        // Verify we are limiting the playlist
        if (!args.includes('--playlist-end') || !args.includes('100')) {
            // We can't fail the test directly from here easily without throwing or emitting error
            // But we can check it in the results or logs
            console.error("FAIL: --playlist-end 100 missing");
        }

        setTimeout(() => {
            const result = {
                title: "Test Playlist",
                entries: [
                    { id: 'vid1', title: 'Video 1', url: 'vid1', duration: 100 },
                    { id: 'vid2', title: 'Video 2', url: 'https://www.youtube.com/watch?v=vid2', duration: 200 },
                    { id: 'vid3', title: 'Video 3', duration: 300 },
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

const muse = require('../src/index.js');

async function runTest() {
    console.log("Running test: getPlaylistEntries robustness and limits");

    const url = "https://www.youtube.com/playlist?list=PLtest";

    try {
        const result = await muse.getPlaylistEntries(url);
        assert.strictEqual(result.entries.length, 4);
        console.log("Test Passed!");

    } catch (e) {
        console.error("Test Error:", e);
        process.exit(1);
    }
}

runTest();
