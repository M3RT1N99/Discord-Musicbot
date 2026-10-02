'use strict';
// Unit tests for the local music library index behind /playlocalmusic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbot-library-'));
process.env.LOG_DIR = TMP;
process.env.LOG_LEVEL = 'error';

const { LocalMusicLibrary, collectLocalAudioFiles } = require('../src/library/LocalMusicLibrary');

let rootN = 0;
function makeLibrary(files) {
    const root = path.join(TMP, `lib-${++rootN}`);
    fs.mkdirSync(root, { recursive: true });
    for (const rel of files) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), 'x');
    }
    return root;
}

test('index lists every non-hidden folder with audio below it, with recursive counts', async () => {
    const root = makeLibrary([
        'Rock/a.mp3', 'Rock/Live/b.FLAC', 'Rock/Live/cover.jpg',
        'Leer/readme.txt', '.Trash-1000/old.mp3', 'Rock/.hidden/c.mp3',
        'loose.mp3', 'Jazz/Unterordner/d.m4a'
    ]);
    const lib = new LocalMusicLibrary(root);
    const folders = await lib.getFolders();
    assert.deepEqual(folders.map(f => [f.relPath, f.depth, f.audioCount]), [
        ['Jazz', 1, 1],
        ['Jazz/Unterordner', 2, 1],
        ['Rock', 1, 2],
        ['Rock/Live', 2, 1]
    ]);
    const live = folders.find(f => f.relPath === 'Rock/Live');
    assert.equal(live.absPath, path.join(root, 'Rock', 'Live'));
    assert.equal(live.name, 'Live');
    assert.equal(live.key, 'Rock/Live');
});

test('an unreadable root rejects; unreadable subfolders are skipped', async (t) => {
    await assert.rejects(new LocalMusicLibrary(path.join(TMP, 'missing')).getFolders(), { code: 'ENOENT' });

    const root = makeLibrary(['Ok/a.mp3', 'Gesperrt/b.mp3']);
    const realReaddir = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (dir, opts) => {
        if (dir === path.join(root, 'Gesperrt')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return realReaddir.call(fs.promises, dir, opts);
    });
    const folders = await new LocalMusicLibrary(root).getFolders();
    assert.deepEqual(folders.map(f => f.relPath), ['Ok']);
});

test('autocomplete ranks name prefix, then name substring, then path matches; at most 25 choices', async () => {
    const root = makeLibrary([
        'Best of Rock/a.mp3', 'Rockabilly/a.mp3', 'Hard Rock/a.mp3', 'Rock/a.mp3',
        'Sammlung/Rock/a.mp3', 'Rock Classics/Disc 2/a.mp3', 'Rock Classics/Disc 10/a.mp3',
        ...Array.from({ length: 30 }, (_, i) => `Album ${i + 1}/a.mp3`)
    ]);
    const lib = new LocalMusicLibrary(root);

    const rock = (await lib.autocomplete('rock')).map(c => c.value);
    assert.deepEqual(rock, [
        'Rock', 'Rock Classics', 'Rockabilly', 'Sammlung/Rock', // name starts with "rock" (shallow first)
        'Best of Rock', 'Hard Rock',                            // name contains "rock"
        'Rock Classics/Disc 2', 'Rock Classics/Disc 10'         // only the path contains it (natural order)
    ]);

    const all = await lib.autocomplete('');
    assert.equal(all.length, 25, 'Discord shows at most 25 choices');
    assert.deepEqual(all.slice(0, 3).map(c => c.value), ['Album 1', 'Album 2', 'Album 3'], 'natural order');
    assert.ok(all.every(c => !c.value.includes('/')), 'empty query lists top-level folders first');

    assert.deepEqual(await lib.autocomplete('gibt es nicht'), []);
});

test('matching ignores case, accents and Unicode normalization', async () => {
    const root = makeLibrary(['Bänger/a.mp3', 'Русская музыка/a.mp3']);
    const lib = new LocalMusicLibrary(root);
    for (const query of ['bänger', 'BANGER', 'Bän']) {
        assert.deepEqual((await lib.autocomplete(query)).map(c => c.value), ['Bänger'], query);
    }
    assert.deepEqual((await lib.autocomplete('русск')).map(c => c.value), ['Русская музыка']);
    assert.equal((await lib.resolve('banger')).relPath, 'Bänger');
    assert.equal((await lib.resolve('русская МУЗЫКА')).relPath, 'Русская музыка');
});

test('choice names and values respect the 100-character limit without splitting characters', async () => {
    const longRel = '🎵'.repeat(30) + '/' + 'ä'.repeat(70);
    const root = makeLibrary([longRel + '/a.mp3']);
    const lib = new LocalMusicLibrary(root);
    const choices = await lib.autocomplete('ä');
    assert.equal(choices.length, 1);
    const [choice] = choices;
    assert.ok(choice.name.length <= 100, `name ${choice.name.length}`);
    assert.ok(choice.value.length <= 100, `value ${choice.value.length}`);
    assert.ok(choice.name.startsWith('…') && choice.name.endsWith(' (1)'));
    assert.equal(choice.name.isWellFormed(), true, 'no lone surrogates');
    assert.match(choice.value, /^#[0-9a-f]{16}$/);
    assert.equal((await lib.resolve(choice.value)).relPath, longRel);

    // The emoji folder itself (61 UTF-16 units) still fits and keeps its path as value
    const top = (await lib.autocomplete('🎵'))[0];
    assert.equal(top.value, '🎵'.repeat(30));
});

test('resolve: by value, by path, by folder name (shallowest), never outside the library', async () => {
    const root = makeLibrary(['Mix/a.mp3', 'Archiv/Mix/b.mp3', 'Archiv/c.mp3']);
    const lib = new LocalMusicLibrary(root);
    assert.equal((await lib.resolve('Archiv/Mix')).absPath, path.join(root, 'Archiv', 'Mix'));
    assert.equal((await lib.resolve('archiv\\mix\\')).relPath, 'Archiv/Mix', 'backslashes, case, trailing slash');
    assert.equal((await lib.resolve('mix')).relPath, 'Mix', 'name match prefers the shallowest folder');

    const outside = path.join(TMP, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'x.mp3'), 'x');
    for (const value of ['', '..', '../outside', outside, '/', 'Archiv/../..', 'Mix/../../outside', null, undefined, 42]) {
        assert.equal(await lib.resolve(value), null, String(value));
    }
});

test('a miss rescans once, so folders added after the last scan are found', async () => {
    const root = makeLibrary(['Alt/a.mp3']);
    const lib = new LocalMusicLibrary(root);
    await lib.getFolders();
    fs.mkdirSync(path.join(root, 'Neu'));
    fs.writeFileSync(path.join(root, 'Neu', 'b.mp3'), 'x');
    assert.equal((await lib.resolve('Neu')).relPath, 'Neu');
});

test('refresh is single-flight; a stale index is served while it rescans', async () => {
    const root = makeLibrary(['A/a.mp3']);
    const lib = new LocalMusicLibrary(root, { ttlMs: 60000 });
    const first = lib.refresh();
    assert.equal(lib.refresh(), first, 'concurrent callers share one scan');
    const initial = await first;
    assert.equal(lib.scanning, null);

    fs.mkdirSync(path.join(root, 'B'));
    fs.writeFileSync(path.join(root, 'B', 'b.mp3'), 'x');
    assert.equal(await lib.getFolders(), initial, 'fresh index: no rescan');
    assert.equal(lib.scanning, null);

    lib.indexedAt -= 60001; // index is now older than the TTL
    assert.equal(await lib.getFolders(), initial, 'stale index is returned right away');
    assert.ok(lib.scanning, 'background rescan started');
    await lib.scanning;
    assert.deepEqual((await lib.getFolders()).map(f => f.relPath), ['A', 'B']);
});

test('autocomplete gives up waiting for a slow first scan instead of missing the deadline', async (t) => {
    const root = makeLibrary(['A/a.mp3']);
    const realReaddir = fs.promises.readdir;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(fs.promises, 'readdir', async (dir, opts) => {
        await gate;
        return realReaddir.call(fs.promises, dir, opts);
    });
    const lib = new LocalMusicLibrary(root);
    const started = Date.now();
    assert.deepEqual(await lib.autocomplete('a', { maxWaitMs: 30 }), []);
    assert.ok(Date.now() - started < 1000);
    release();
    await lib.scanning;
    assert.deepEqual((await lib.autocomplete('a')).map(c => c.value), ['A'], 'the scan finished in the background');
});

test('collectLocalAudioFiles: recursive, natural order, case-insensitive extensions, skips hidden and non-audio', async () => {
    const root = makeLibrary(['10 Zehn.mp3', '2 Zwei.MP3', 'sub/b.opus', 'sub/.hidden/x.mp3', '.versteckt/y.mp3', 'notes.txt', 'cover.JPG']);
    assert.deepEqual(await collectLocalAudioFiles(root), [
        path.join(root, '2 Zwei.MP3'),
        path.join(root, '10 Zehn.mp3'),
        path.join(root, 'sub', 'b.opus')
    ]);
    await assert.rejects(collectLocalAudioFiles(path.join(root, 'fehlt')), { code: 'ENOENT' });
});
