'use strict';
// Characterization of the slash-command, button and select-menu handlers:
// exact replies, queue mutations, track shapes and UI payloads, driven with
// fake interactions. Runs offline: spawn, voice joins and the yt-dlp wrappers
// are faked before the bot modules load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbot-handlers-'));
const DOWNLOADS = path.join(TMP, 'downloads');
const MUSIC = path.join(TMP, 'music');
process.env.DOWNLOAD_DIR = DOWNLOADS;
process.env.LOG_DIR = TMP;
process.env.LOG_LEVEL = 'error';
process.env.LOCAL_MUSIC_DIR = MUSIC;
process.env.TOKEN = 'test-token';
fs.mkdirSync(DOWNLOADS, { recursive: true });
// Library: nested folders, a hidden folder, a folder without audio, a path > 100 chars
const LONG_REL = 'Tief/' + 'x'.repeat(60) + '/' + 'y'.repeat(50);
const musicFile = (rel, content = 'x') => {
    fs.mkdirSync(path.dirname(path.join(MUSIC, rel)), { recursive: true });
    fs.writeFileSync(path.join(MUSIC, rel), content);
};
musicFile('Gemeinde Gottes/10 Zehn.mp3');
musicFile('Gemeinde Gottes/2 Zwei.MP3');
musicFile('Gemeinde Gottes/sub/b.opus');
musicFile('Gemeinde Gottes/notes.txt');
musicFile('Gemeinde Gottes/.hidden/h.mp3');
musicFile('Spotify/Bänger/x.mp3');
musicFile('Leer/cover.jpg');
musicFile(LONG_REL + '/deep.flac');
musicFile('loose.mp3');

// ---- fakes that must exist BEFORE the bot modules load (they destructure at require time)
const cp = require('child_process');
cp.spawn = () => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.exitCode = null; p.signalCode = null; p.kills = [];
    p.kill = (sig = 'SIGTERM') => { p.kills.push(sig); return true; };
    return p;
};

const { REST, MessageFlags } = require('discord.js');
const restCalls = [];
let restFails = false;
REST.prototype.put = async function (route, opts) {
    if (restFails) throw new Error('rest down');
    restCalls.push({ route, body: opts.body });
    return [];
};

const ytdlp = require('../src/download/ytdlp');
let videoInfoImpl, playlistImpl, searchImpl, downloadImpl;
ytdlp.getVideoInfo = (url) => videoInfoImpl(url);
ytdlp.getPlaylistEntries = (url) => playlistImpl(url);
ytdlp.searchYouTubeVideos = (query, n) => searchImpl(query, n);
ytdlp.downloadSingleTo = (fp, url, cb) => downloadImpl(fp, url, cb);

const VM = require('../src/voice/VoiceManager');
let joinImpl = async () => fakeConn();
VM.joinVoiceChannelWithRetry = (channel) => joinImpl(channel);

const QM = require('../src/queue/QueueManager');
const ensureCalls = [];
const skipCalls = [];
const realSkip = QM.skipCurrentTrack;
QM.ensureNextTrackDownloadedAndPlay = (guildId, audioCache) => { ensureCalls.push([guildId, audioCache]); };
QM.skipCurrentTrack = (guildId) => { skipCalls.push(guildId); return realSkip(guildId); };

const CH = require('../src/commands/commandHandlers');
const ui = require('../src/ui/messages');
const logger = require('../src/utils/logger');
const { MAX_QUERY_LENGTH } = require('../src/config/constants');
const { sanitizeString } = require('../src/utils/validation');
const { LocalMusicLibrary } = require('../src/library/LocalMusicLibrary');
const library = new LocalMusicLibrary(MUSIC);

// ---- helpers
const SUPPRESS = [MessageFlags.SuppressNotifications];
const wire = (value) => JSON.parse(JSON.stringify(value));
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function fakePlayer(status = 'playing') {
    const p = new EventEmitter();
    p.state = { status }; p.stopCalls = 0; p.unpauseCalls = 0; p.plays = [];
    p.play = (r) => { p.plays.push(r); p.state = { status: 'playing', resource: r }; };
    p.stop = () => { p.stopCalls++; return true; };
    p.pause = () => { p.state = { status: 'paused' }; return true; };
    p.unpause = () => { p.unpauseCalls++; p.state = { status: 'playing' }; return true; };
    return p;
}
function fakeConn() {
    const c = new EventEmitter();
    c.state = { status: 'ready' }; c.destroyCalls = 0; c.subscribed = [];
    c.destroy = () => { c.destroyCalls++; c.state = { status: 'destroyed' }; c.emit('destroyed'); };
    c.subscribe = (player) => { c.subscribed.push(player); };
    return c;
}
function fakeMessage(payload, v2 = false) {
    return {
        id: 'msg-' + Math.abs(JSON.stringify(payload ?? null).length),
        payload, edits: [], deletes: 0,
        flags: { has: (flag) => v2 && flag === MessageFlags.IsComponentsV2 },
        edit(p) { this.edits.push(p); return Promise.resolve(this); },
        delete() { this.deletes++; return Promise.resolve(); }
    };
}
function fakeInteraction({ guildId = 'g', userId = 'u1', voice = true, options = {}, customId, values, admin = false, message, createdTimestamp = Date.now() } = {}) {
    const log = [];
    const messages = [];
    const respond = (via, payload) => { log.push([via, payload]); const m = fakeMessage(payload); messages.push(m); return m; };
    return {
        log, messages, guildId, customId, values, message, createdTimestamp,
        user: { id: userId, tag: 'user#0001' },
        member: { voice: { channel: voice ? { id: 'vc1' } : null }, permissions: { has: () => admin } },
        channel: { id: 'tc1' },
        client: { application: { id: 'app1' }, channels: { cache: new Map() } },
        replied: false, deferred: false,
        options: { getString: (n) => options[n], getInteger: (n) => options[n] },
        async reply(p) { this.replied = true; return respond('reply', p); },
        async deferReply() { this.deferred = true; log.push(['deferReply']); },
        async editReply(p) { this.replied = true; return respond('editReply', p); },
        async followUp(p) { return respond('followUp', p); },
        async update(p) { this.replied = true; return respond('update', p); },
        async deferUpdate() { this.deferred = true; log.push(['deferUpdate']); }
    };
}
function fakeCache(entries = {}) {
    return {
        sets: [], cleared: 0, failClear: false,
        has: (url) => Object.prototype.hasOwnProperty.call(entries, url),
        get: (url) => entries[url]?.filepath ?? null,
        getEntry: (url) => entries[url] ?? null,
        set(url, filepath, meta) { this.sets.push({ url, filepath, meta }); },
        getAllEntries: () => Object.entries(entries),
        getStats: () => ({ size: Object.keys(entries).length, maxSize: 200, hits: 1, misses: 2 }),
        clear() { if (this.failClear) throw new Error('disk'); this.cleared++; }
    };
}
function fakeBackground() {
    return {
        added: [],
        addToQueue(guildId, track) { this.added.push([guildId, track]); },
        processQueue() { },
        getStats: () => ({ isActive: false, queueLength: 0 })
    };
}
function ctx(interaction, extra = {}) {
    return {
        interaction,
        audioCache: fakeCache(),
        searchCache: { store: new Map(), set(k, v) { this.store.set(k, v); }, get(k) { return this.store.get(k) ?? null; }, delete(k) { this.store.delete(k); } },
        rateLimiter: { check: () => true },
        backgroundDownloader: fakeBackground(),
        localMusic: library,
        guildQueues: QM.guildQueues,
        createPlayerForGuild: () => fakePlayer('playing'),
        createGuildQueue: QM.createGuildQueue,
        deleteGuildQueue: QM.deleteGuildQueue,
        commandBuilders: [],
        logger,
        ...extra
    };
}
let guildN = 0;
function newQueue(status = 'playing') {
    const guildId = `guild-${++guildN}`;
    const queue = QM.createGuildQueue(guildId, fakeConn(), fakePlayer(status), { id: 'tc0' });
    return { guildId, queue };
}
function remoteSongs(n) {
    return Array.from({ length: n }, (_, i) => ({ title: 'r' + i, url: `https://example.com/r${i}.mp3`, filepath: null }));
}
const TRACK = { requesterId: 'u1', title: 'Song A', url: 'https://example.com/a.mp3', duration: '3:00' };
const VIDEO = 'https://www.youtube.com/watch?v=abcdefghijk';
const PL_ID = 'PL0123456789abcdefghij0123456789ab';

test.afterEach(() => {
    for (const guildId of [...QM.guildQueues.keys()]) QM.deleteGuildQueue(guildId);
    ensureCalls.length = 0;
    skipCalls.length = 0;
    restCalls.length = 0;
    restFails = false;
    joinImpl = async () => fakeConn();
});

// =============================== playback controls ===============================

test('playback commands without a queue reply ephemerally', async () => {
    const cases = [
        ['handlePauseCommand', '❌ Keine aktive Wiedergabe.'],
        ['handleResumeCommand', '❌ Keine aktive Wiedergabe.'],
        ['handleSkipCommand', '❌ Keine aktive Wiedergabe.'],
        ['handleStopCommand', '❌ Keine aktive Wiedergabe.'],
        ['handleVolumeCommand', '❌ Keine aktive Wiedergabe.'],
        ['handleLeaveCommand', '❌ Ich bin in keinem Sprachkanal.'],
        ['handleShuffleCommand', '❌ Keine Queue vorhanden.'],
        ['handleRepeatSingleCommand', '❌ Keine Queue vorhanden.'],
        ['handleRepeatCommand', '❌ Keine Queue vorhanden.'],
        ['handleQueueCommand', '📋 Queue ist leer.']
    ];
    for (const [name, content] of cases) {
        const i = fakeInteraction({ guildId: 'no-queue', options: { wert: 30 } });
        await CH[name](ctx(i));
        assert.deepEqual(i.log, [['reply', { content, ephemeral: true }]], name);
    }
});

test('/pause and /resume drive the player and refresh a V2 now-playing card', async () => {
    const { guildId, queue } = newQueue('playing');
    queue.currentTrack = TRACK;
    const card = fakeMessage(null, true);
    queue.nowPlayingMessage = card;

    let i = fakeInteraction({ guildId });
    await CH.handlePauseCommand(ctx(i));
    assert.equal(queue.player.state.status, 'paused');
    assert.deepEqual(i.log, [['reply', { content: '⏸️ Pausiert', ephemeral: true }]]);
    assert.equal(card.edits.length, 1);
    assert.deepEqual(wire(card.edits[0]), wire({ components: [ui.buildNowPlayingCard(guildId, queue, TRACK)] }));

    i = fakeInteraction({ guildId });
    await CH.handleResumeCommand(ctx(i));
    assert.equal(queue.player.unpauseCalls, 1);
    assert.deepEqual(i.log, [['reply', { content: '▶️ Fortgesetzt', ephemeral: true }]]);
    assert.equal(card.edits.length, 2);

    // Pre-Components-V2 cards are left untouched
    const legacy = fakeMessage(null, false);
    queue.nowPlayingMessage = legacy;
    await CH.handlePauseCommand(ctx(fakeInteraction({ guildId })));
    assert.equal(legacy.edits.length, 0);
});

test('/skip deletes the card, skips and replies', async () => {
    const { guildId, queue } = newQueue('playing');
    const card = fakeMessage(null, true);
    queue.nowPlayingMessage = card;

    const i = fakeInteraction({ guildId });
    await CH.handleSkipCommand(ctx(i));
    assert.equal(card.deletes, 1);
    assert.equal(queue.nowPlayingMessage, null);
    assert.deepEqual(skipCalls, [guildId]);
    assert.equal(queue.skipRequested, true);
    assert.equal(queue.player.stopCalls, 1);
    assert.deepEqual(i.log, [['reply', { content: '⏭️ Übersprungen', ephemeral: true }]]);
});

test('/stop and /leave tear the queue down', async () => {
    let { guildId, queue } = newQueue('playing');
    const card = fakeMessage(null, true);
    queue.nowPlayingMessage = card;
    let i = fakeInteraction({ guildId });
    await CH.handleStopCommand(ctx(i));
    assert.equal(card.deletes, 2, '/stop deletes the card, cleanup deletes it again');
    assert.equal(QM.guildQueues.has(guildId), false);
    assert.equal(queue.connection.destroyCalls, 1);
    assert.deepEqual(i.log, [['reply', { content: '⏹️ Gestoppt und Queue geleert', ephemeral: true }]]);

    ({ guildId, queue } = newQueue('playing'));
    i = fakeInteraction({ guildId });
    await CH.handleLeaveCommand(ctx(i));
    assert.equal(QM.guildQueues.has(guildId), false);
    assert.equal(queue.connection.destroyCalls, 1);
    assert.deepEqual(i.log, [['reply', { content: '👋 Tschüss!', ephemeral: true }]]);
});

test('/volume clamps, applies to the live resource and refreshes the card', async () => {
    const { guildId, queue } = newQueue('playing');
    queue.currentTrack = TRACK;
    queue.nowPlayingMessage = fakeMessage(null, true);
    const applied = [];
    queue.currentResource = { volume: { setVolume: (v) => applied.push(v) } };

    let i = fakeInteraction({ guildId, options: { wert: 150 } });
    await CH.handleVolumeCommand(ctx(i));
    assert.equal(queue.volume, 100);
    assert.deepEqual(i.log, [['reply', { content: '🔊 Lautstärke auf 100 % gesetzt', ephemeral: true }]]);

    i = fakeInteraction({ guildId, options: { wert: -5 } });
    await CH.handleVolumeCommand(ctx(i));
    assert.equal(queue.volume, 0);
    assert.deepEqual(i.log, [['reply', { content: '🔊 Lautstärke auf 0 % gesetzt', ephemeral: true }]]);

    assert.deepEqual(applied, [1, 0]);
    assert.equal(queue.nowPlayingMessage.edits.length, 2);

    // No live resource: only the stored value changes
    queue.currentResource = null;
    await CH.handleVolumeCommand(ctx(fakeInteraction({ guildId, options: { wert: 40 } })));
    assert.equal(queue.volume, 40);
});

test('/shuffle, /repeatsingle and /repeat toggle modes', async () => {
    const { guildId, queue } = newQueue('playing');
    const reply = async (name) => {
        const i = fakeInteraction({ guildId });
        await CH[name](ctx(i));
        assert.equal(i.log.length, 1);
        assert.equal(i.log[0][1].ephemeral, true);
        return i.log[0][1].content;
    };

    queue._nextPrepared = true;
    assert.equal(await reply('handleShuffleCommand'), '🔀 Shuffle aktiviert');
    assert.equal(queue.shuffle, true);
    assert.equal(queue._nextPrepared, false);
    assert.equal(await reply('handleShuffleCommand'), '🔀 Shuffle deaktiviert');
    assert.equal(queue.shuffle, false);

    assert.equal(await reply('handleRepeatSingleCommand'), '🔂 Song-Loop: an');
    assert.equal(queue.loopMode, 'song');
    assert.equal(await reply('handleRepeatSingleCommand'), '➡️ Song-Loop: aus');
    assert.equal(queue.loopMode, 'off');

    assert.equal(await reply('handleRepeatCommand'), '🔁 Queue-Loop: an');
    assert.equal(queue.loopMode, 'queue');
    assert.equal(await reply('handleRepeatSingleCommand'), '🔂 Song-Loop: an');
    assert.equal(queue.loopMode, 'song');
    assert.equal(await reply('handleRepeatCommand'), '🔁 Queue-Loop: an');
    assert.equal(await reply('handleRepeatCommand'), '➡️ Queue-Loop: aus');
    assert.equal(queue.loopMode, 'off');
});

test('/queue shows the queue embed publicly, or the empty notice', async () => {
    const { guildId, queue } = newQueue('playing');
    let i = fakeInteraction({ guildId });
    await CH.handleQueueCommand(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '📋 Queue ist leer.', ephemeral: true }]]);

    queue.currentTrack = TRACK;
    queue.songs.push({ title: 'Next', url: 'https://example.com/n.mp3', duration: '1:00' });
    i = fakeInteraction({ guildId });
    await CH.handleQueueCommand(ctx(i));
    assert.deepEqual(wire(i.log), wire([['reply', { embeds: [ui.queueEmbed(queue)] }]]));
});

// =============================== maintenance ===============================

test('/debug replies with the debug embed', async () => {
    const i = fakeInteraction({ guildId: 'g-debug' });
    const c = ctx(i);
    await CH.handleDebugCommand(c);
    const strip = (v) => { const w = wire(v); for (const e of w[0][1].embeds) delete e.timestamp; return w; };
    const expected = ui.debugEmbed({
        guildId: 'g-debug', voiceChannel: { id: 'vc1' }, cacheStats: c.audioCache.getStats(),
        queueCount: QM.guildQueues.size, bgStats: c.backgroundDownloader.getStats()
    });
    assert.deepEqual(strip(i.log), strip([['reply', { embeds: [expected], ephemeral: true }]]));
});

test('/test requires a voice channel', async () => {
    const i = fakeInteraction({ voice: false });
    await CH.handleTestCommand(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: 'Du musst in einem Sprachkanal sein!', ephemeral: true }]]);
});

test('/refresh is admin-only and re-registers the commands of the guild', async () => {
    const commandBuilders = [{ toJSON: () => ({ name: 'a' }) }, { toJSON: () => ({ name: 'b' }) }];

    let i = fakeInteraction({ guildId: 'g-ref', admin: false });
    await CH.handleRefreshCommand(ctx(i, { commandBuilders }));
    assert.deepEqual(i.log, [['reply', { content: '❌ Administrator-Berechtigung erforderlich.', ephemeral: true }]]);

    i = fakeInteraction({ guildId: 'g-ref', admin: true });
    await CH.handleRefreshCommand(ctx(i, { commandBuilders }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '✅ Commands erfolgreich aktualisiert! (2 Commands registriert)']]);
    assert.deepEqual(restCalls, [
        { route: '/applications/app1/commands', body: [] },
        { route: '/applications/app1/guilds/g-ref/commands', body: [{ name: 'a' }, { name: 'b' }] }
    ]);
});

test('/refresh reports registration failures', async (t) => {
    t.mock.method(logger, 'error', () => { });
    restFails = true;
    let i = fakeInteraction({ guildId: 'g-ref', admin: true });
    await CH.handleRefreshCommand(ctx(i, { commandBuilders: [{ toJSON: () => ({ name: 'a' }) }] }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '❌ Fehler beim Registrieren der Commands.']]);

    restFails = false;
    i = fakeInteraction({ guildId: 'g-ref', admin: true });
    await CH.handleRefreshCommand(ctx(i, { commandBuilders: [] }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '❌ Fehler beim Registrieren der Commands.']]);
    assert.deepEqual(restCalls, []);
    assert.deepEqual(logger.error.mock.calls.map(c => c.arguments[0]), [
        '[REFRESH ERROR] rest down',
        '[REFRESH ERROR] No command definitions available'
    ]);
});

test('/clearcache is admin-only and clears the cache', async (t) => {
    let i = fakeInteraction({ admin: false });
    await CH.handleClearcacheCommand(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '❌ Administrator-Berechtigung erforderlich.', ephemeral: true }]]);

    const audioCache = fakeCache({ a: { filepath: 'a' }, b: { filepath: 'b' }, c: { filepath: 'c' } });
    i = fakeInteraction({ admin: true });
    await CH.handleClearcacheCommand(ctx(i, { audioCache }));
    assert.equal(audioCache.cleared, 1);
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '✅ Cache geleert! 3 Einträge entfernt.']]);

    t.mock.method(logger, 'error', () => { });
    audioCache.failClear = true;
    i = fakeInteraction({ admin: true });
    await CH.handleClearcacheCommand(ctx(i, { audioCache }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '❌ Fehler beim Leeren des Caches.']]);
});

// =============================== library ===============================

test('/playcache queues existing cached files and kicks playback', async () => {
    const f1 = path.join(TMP, 'cached-1.opus');
    const f2 = path.join(TMP, 'cached-2.opus');
    fs.writeFileSync(f1, 'x');
    fs.writeFileSync(f2, 'x');
    const audioCache = fakeCache({
        'https://example.com/1.mp3': { filepath: f1, filename: 'cached-1.opus', meta: { title: 'Eins', duration: '1:00' } },
        'yt-key': { filepath: f2, filename: 'cached-2.opus' },
        'https://example.com/gone.mp3': { filepath: path.join(TMP, 'gone.opus'), meta: { title: 'Weg' } }
    });
    const { guildId, queue } = newQueue('playing');

    const i = fakeInteraction({ guildId });
    const c = ctx(i, { audioCache });
    await CH.handlePlaycacheCommand(c);
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '✅ **2** Songs aus dem Cache zur Queue hinzugefügt.']]);
    assert.deepEqual(queue.songs, [
        { requesterId: 'u1', title: 'Eins', filepath: f1, url: 'https://example.com/1.mp3', duration: '1:00', isCached: true },
        { requesterId: 'u1', title: 'cached-2.opus', filepath: f2, url: null, duration: undefined, isCached: true }
    ]);
    assert.deepEqual(ensureCalls, [[guildId, audioCache]]);
});

test('/playcache edge cases: no voice, empty cache, nothing valid, queue limit, join failure', async () => {
    let i = fakeInteraction({ voice: false });
    await CH.handlePlaycacheCommand(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: 'Du musst in einem Sprachkanal sein!', ephemeral: true }]]);

    i = fakeInteraction();
    await CH.handlePlaycacheCommand(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '📦 Cache ist leer.', ephemeral: true }]]);

    const missing = fakeCache({ 'https://example.com/x.mp3': { filepath: path.join(TMP, 'missing.opus') } });
    let { guildId } = newQueue('playing');
    i = fakeInteraction({ guildId });
    await CH.handlePlaycacheCommand(ctx(i, { audioCache: missing }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '❌ Keine gültigen Dateien im Cache gefunden.']]);

    const f = path.join(TMP, 'cached-3.opus');
    fs.writeFileSync(f, 'x');
    const two = fakeCache({ 'https://example.com/3.mp3': { filepath: f }, 'https://example.com/4.mp3': { filepath: f } });
    let queue;
    ({ guildId, queue } = newQueue('playing'));
    queue.songs.push(...remoteSongs(499));
    i = fakeInteraction({ guildId });
    await CH.handlePlaycacheCommand(ctx(i, { audioCache: two }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '✅ **1** Songs aus dem Cache zur Queue hinzugefügt.\n⚠️ Queue-Limit erreicht (max. 500).']]);
    assert.equal(queue.songs.length, 500);

    joinImpl = async () => { throw new Error('kein Zugriff'); };
    i = fakeInteraction({ guildId: 'g-nojoin' });
    await CH.handlePlaycacheCommand(ctx(i, { audioCache: two }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '❌ Fehler beim Beitreten: kein Zugriff']]);
});

test('/playlocalmusic queues all audio files of the chosen folder in natural order', async () => {
    const i = fakeInteraction({ guildId: 'g-local', options: { ordner: 'Gemeinde Gottes' } });
    const c = ctx(i);
    await CH.handlePlayLocalMusicCommand(c);

    const queue = QM.guildQueues.get('g-local');
    assert.ok(queue, 'joined and created a queue');
    assert.equal(queue.audioCache, c.audioCache);
    const local = (rel, title) => ({
        requesterId: 'u1', title, filepath: path.join(MUSIC, 'Gemeinde Gottes', rel), url: null, duration: 'lokale Datei',
        isLocalFile: true, playlistTitle: 'Gemeinde Gottes', relativePath: path.join('Gemeinde Gottes', rel)
    });
    assert.deepEqual(queue.songs, [
        local('2 Zwei.MP3', '2 Zwei'),
        local('10 Zehn.mp3', '10 Zehn'),
        local(path.join('sub', 'b.opus'), 'b')
    ], 'hidden folders and non-audio files are skipped');
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '✅ **3** lokale Audiodateien aus `Gemeinde Gottes` zur Queue hinzugefügt.']]);
    assert.deepEqual(ensureCalls, [['g-local', c.audioCache]]);
});

test('/playlocalmusic resolves nested folders, typed names and hashed long paths', async () => {
    const run = async (ordner) => {
        const { guildId, queue } = newQueue('playing');
        const i = fakeInteraction({ guildId, options: { ordner } });
        await CH.handlePlayLocalMusicCommand(ctx(i));
        return { queue, reply: i.log.at(-1)[1] };
    };

    let r = await run('Spotify/Bänger');
    assert.equal(r.reply, '✅ **1** lokale Audiodateien aus `Spotify/Bänger` zur Queue hinzugefügt.');
    assert.equal(r.queue.songs[0].playlistTitle, 'Spotify/Bänger');
    assert.equal(r.queue.songs[0].relativePath, path.join('Spotify', 'Bänger', 'x.mp3'));

    r = await run('  gemeinde gottes  ');
    assert.equal(r.queue.songs.length, 3, 'typed name, other case and padding');

    r = await run('BANGER');
    assert.equal(r.queue.songs[0].playlistTitle, 'Spotify/Bänger', 'folder name alone, accents folded');

    const [choice] = await library.autocomplete('yyy');
    assert.match(choice.value, /^#[0-9a-f]{16}$/, 'paths over 100 chars get a hashed value');
    r = await run(choice.value);
    assert.equal(r.queue.songs.length, 1);
    assert.equal(r.queue.songs[0].playlistTitle, LONG_REL);
});

test('/playlocalmusic rejects unknown folders, folders without audio and path tricks', async () => {
    const tricks = ['Gibts nicht', 'Leer', '..', '../downloads', 'Gemeinde Gottes/../../downloads', DOWNLOADS, '/'];
    for (const ordner of tricks) {
        const i = fakeInteraction({ guildId: 'g-local-none', options: { ordner } });
        await CH.handlePlayLocalMusicCommand(ctx(i));
        assert.deepEqual(i.log, [['deferReply'], ['editReply', `❌ Ordner nicht gefunden: \`${sanitizeString(ordner)}\` — wähle einen Ordner aus der Liste.`]], ordner);
        assert.equal(QM.guildQueues.has('g-local-none'), false, ordner);
    }
});

test('/playlocalmusic edge cases: no voice, missing library, vanished or emptied folder, join failure', async (t) => {
    const errored = t.mock.method(logger, 'error', () => { });
    let i = fakeInteraction({ voice: false, options: { ordner: 'Gemeinde Gottes' } });
    await CH.handlePlayLocalMusicCommand(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: 'Du musst in einem Sprachkanal sein!', ephemeral: true }]]);

    const missingRoot = path.join(TMP, 'no-music');
    i = fakeInteraction({ guildId: 'g-local-2', options: { ordner: 'Gemeinde Gottes' } });
    await CH.handlePlayLocalMusicCommand(ctx(i, { localMusic: new LocalMusicLibrary(missingRoot) }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', `❌ Musikordner nicht gefunden: \`${missingRoot}\``]]);

    // Indexed while the files existed, changed before the command ran
    const root = path.join(TMP, 'volatile');
    fs.mkdirSync(path.join(root, 'Weg'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Leer'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Weg', 'a.mp3'), 'x');
    fs.writeFileSync(path.join(root, 'Leer', 'a.mp3'), 'x');
    const volatile = new LocalMusicLibrary(root);
    await volatile.refresh();
    fs.rmSync(path.join(root, 'Weg'), { recursive: true });
    fs.rmSync(path.join(root, 'Leer', 'a.mp3'));

    i = fakeInteraction({ guildId: 'g-local-3', options: { ordner: 'Weg' } });
    await CH.handlePlayLocalMusicCommand(ctx(i, { localMusic: volatile }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '❌ Ordner `Weg` konnte nicht gelesen werden.']]);

    i = fakeInteraction({ guildId: 'g-local-3', options: { ordner: 'Leer' } });
    await CH.handlePlayLocalMusicCommand(ctx(i, { localMusic: volatile }));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '📁 Keine Audiodateien in `Leer` gefunden. Unterstützt: .mp3, .m4a, .wav, .flac, .ogg, .opus, .webm, .aac']]);
    assert.equal(QM.guildQueues.has('g-local-3'), false);

    joinImpl = async () => { throw new Error('voll'); };
    i = fakeInteraction({ guildId: 'g-local-4', options: { ordner: 'Gemeinde Gottes' } });
    await CH.handlePlayLocalMusicCommand(ctx(i));
    assert.deepEqual(i.log, [['deferReply'], ['editReply', '❌ Fehler beim Beitreten: voll']]);

    const logged = errored.mock.calls.map(c => c.arguments[0]);
    assert.equal(logged.length, 2);
    assert.ok(logged[0].startsWith('[PLAYLOCAL] Could not index music library: '), logged[0]);
    assert.ok(logged[1].startsWith('[PLAYLOCAL] Could not read Weg: '), logged[1]);
});

test('/playlocalmusic autocomplete answers once with matching folders and file counts', async (t) => {
    const answer = async (focused, localMusic = library) => {
        const responses = [];
        const interaction = { options: { getFocused: () => focused }, respond: async (choices) => { responses.push(choices); } };
        await CH.handlePlayLocalMusicAutocomplete({ interaction, localMusic });
        assert.equal(responses.length, 1, 'responds exactly once');
        return responses[0];
    };

    assert.deepEqual(await answer('bän'), [{ name: 'Spotify/Bänger (1)', value: 'Spotify/Bänger' }]);
    assert.deepEqual((await answer('')).map(c => c.name), [
        'Gemeinde Gottes (3)', 'Spotify (1)', 'Tief (1)',
        'Gemeinde Gottes/sub (1)', 'Spotify/Bänger (1)', `Tief/${'x'.repeat(60)} (1)`, `…${LONG_REL.slice(-(100 - ' (1)'.length - 1))} (1)`
    ], 'top-level folders first, long paths cut at the front');

    const warned = t.mock.method(logger, 'warn', () => { });
    assert.deepEqual(await answer('x', new LocalMusicLibrary(path.join(TMP, 'no-music'))), []);
    assert.match(warned.mock.calls[0].arguments[0], /^\[PLAYLOCAL\] Autocomplete failed: /);

    // An expired interaction (respond rejects) must not throw
    const expired = { options: { getFocused: () => '' }, respond: async () => { throw new Error('Unknown interaction'); } };
    await CH.handlePlayLocalMusicAutocomplete({ interaction: expired, localMusic: library });
});

// =============================== now-playing buttons ===============================

test('np buttons: missing queue, malformed id, pause/resume with in-place card update', async () => {
    let i = fakeInteraction({ customId: 'np_pause|nope' });
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '❌ Keine aktive Wiedergabe.', ephemeral: true }]]);

    i = fakeInteraction({ customId: 'np_pause' });
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(i.log, []);

    const { guildId, queue } = newQueue('playing');
    queue.currentTrack = TRACK;
    i = fakeInteraction({ customId: `np_pause|${guildId}`, message: fakeMessage(null, true) });
    await CH.handleNowPlayingButton(ctx(i));
    assert.equal(queue.player.state.status, 'paused');
    assert.deepEqual(wire(i.log), wire([['update', { components: [ui.buildNowPlayingCard(guildId, queue, TRACK)] }]]));

    i = fakeInteraction({ customId: `np_pause|${guildId}`, message: fakeMessage(null, false) });
    await CH.handleNowPlayingButton(ctx(i));
    assert.equal(queue.player.unpauseCalls, 1);
    assert.deepEqual(i.log, [['deferUpdate']], 'legacy cards are only acknowledged');

    queue.currentTrack = null;
    i = fakeInteraction({ customId: `np_loop|${guildId}`, message: fakeMessage(null, true) });
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(i.log, [['deferUpdate']], 'nothing playing: only acknowledged');
});

test('np buttons: volume steps, shuffle, loop cycle', async () => {
    const { guildId, queue } = newQueue('playing');
    queue.currentTrack = TRACK;
    const applied = [];
    queue.currentResource = { volume: { setVolume: (v) => applied.push(v) } };
    const press = async (action) => {
        const i = fakeInteraction({ customId: `${action}|${guildId}`, message: fakeMessage(null, true) });
        await CH.handleNowPlayingButton(ctx(i));
        assert.equal(i.log.length, 1);
        assert.equal(i.log[0][0], 'update');
    };

    await press('np_volup');
    assert.equal(queue.volume, 60);
    await press('np_voldn');
    await press('np_voldn');
    assert.equal(queue.volume, 40);
    queue.volume = 100;
    await press('np_volup');
    assert.equal(queue.volume, 100);
    queue.volume = 0;
    await press('np_volup');
    assert.equal(queue.volume, 60, 'volume 0 counts as unset (|| 50)');
    assert.deepEqual(applied, [0.6, 0.5, 0.4, 1, 0.6]);

    queue._nextPrepared = true;
    await press('np_shuffle');
    assert.equal(queue.shuffle, true);
    assert.equal(queue._nextPrepared, false);

    const modes = [];
    for (let n = 0; n < 3; n++) { await press('np_loop'); modes.push(queue.loopMode); }
    assert.deepEqual(modes, ['song', 'queue', 'off']);
});

test('np buttons: skip and prev', async () => {
    const { guildId, queue } = newQueue('playing');
    let i = fakeInteraction({ customId: `np_skip|${guildId}` });
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(skipCalls, [guildId]);
    assert.deepEqual(i.log, [['deferUpdate']]);

    i = fakeInteraction({ customId: `np_prev|${guildId}` });
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '⏮️ Kein vorheriger Song vorhanden.', ephemeral: true }]]);
});

test('np buttons: savequeue as text, as file, or empty', async () => {
    const { guildId, queue } = newQueue('playing');
    queue.currentTrack = { title: 'Lokal', url: null };
    let i = fakeInteraction({ customId: `np_savequeue|${guildId}` });
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '📋 Queue ist leer — nichts zu speichern.', ephemeral: true }]]);

    queue.currentTrack = { title: 'A', url: 'https://example.com/a' };
    queue.songs.push({ url: 'https://example.com/b' }, { title: 'Lokal', url: null });
    i = fakeInteraction({ customId: `np_savequeue|${guildId}` });
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(i.log, [['reply', {
        content: '💾 Queue gespeichert (2 Songs)\n\n1. A — https://example.com/a\n2. Unbekannt — https://example.com/b',
        ephemeral: true
    }]]);

    queue.songs.length = 0;
    for (let n = 0; n < 60; n++) queue.songs.push({ title: 'Long title ' + n, url: 'https://example.com/' + 'x'.repeat(30) + n });
    i = fakeInteraction({ customId: `np_savequeue|${guildId}` });
    await CH.handleNowPlayingButton(ctx(i));
    assert.equal(i.log.length, 1);
    const [via, payload] = i.log[0];
    assert.equal(via, 'reply');
    assert.equal(payload.content, '💾 Queue gespeichert (61 Songs):');
    assert.equal(payload.ephemeral, true);
    assert.equal(payload.files.length, 1);
    assert.match(payload.files[0].name, /^queue_\d+\.txt$/);
    const text = payload.files[0].attachment.toString('utf-8');
    assert.equal(text.split('\n').length, 61);
    assert.equal(text.split('\n')[0], '1. A — https://example.com/a');
});

test('np buttons: a failing card update falls back to an ephemeral error', async (t) => {
    const warned = t.mock.method(logger, 'warn', () => { });
    const { guildId, queue } = newQueue('playing');
    queue.currentTrack = TRACK;
    const i = fakeInteraction({ customId: `np_loop|${guildId}`, message: fakeMessage(null, true) });
    i.update = async () => { throw new Error('Unknown Message'); };
    await CH.handleNowPlayingButton(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '❌ Aktion fehlgeschlagen.', ephemeral: true }]]);
    assert.deepEqual(warned.mock.calls.map(c => c.arguments[0]), ['[NP BUTTON] Unknown Message']);
});

// =============================== /play prelude, search, select ===============================

test('/play prelude: voice, rate limit, input validation, expired interaction', async () => {
    const run = async (opts, extra) => { const i = fakeInteraction(opts); await CH.handlePlayCommand(ctx(i, extra)); return i.log; };

    assert.deepEqual(await run({ voice: false, options: { query: 'x' } }),
        [['reply', { content: 'Du musst in einem Sprachkanal sein!', ephemeral: true }]]);
    assert.deepEqual(await run({ options: { query: 'x' } }, { rateLimiter: { check: () => false } }),
        [['reply', { content: '⚠️ Du hast zu viele Downloads angefragt. Warte eine Minute.', ephemeral: true }]]);
    assert.deepEqual(await run({ options: { query: '<>|' } }),
        [['reply', { content: '❌ Eingabe enthält ungültige Zeichen.', ephemeral: true }]]);
    assert.deepEqual(await run({ options: { query: 'a'.repeat(MAX_QUERY_LENGTH + 1) } }),
        [['reply', { content: `❌ Eingabe zu lang (max. ${MAX_QUERY_LENGTH} Zeichen).`, ephemeral: true }]]);
    assert.deepEqual(await run({ options: { query: 'x' }, createdTimestamp: Date.now() - 16 * 60 * 1000 }), []);
});

test('/play search: results message, cache entry and error replies', async () => {
    const results = [
        { index: 1, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Erster', uploader: 'X', duration: '1:00' },
        { index: 2, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'Zweiter', uploader: 'Y', duration: '2:00' }
    ];
    searchImpl = async (query, n) => { assert.equal(query, 'hello world'); assert.equal(n, 10); return results; };
    const i = fakeInteraction({ options: { query: 'hello world' } });
    const c = ctx(i);
    await CH.handlePlayCommand(c);
    assert.deepEqual(wire(i.log), wire([
        ['deferReply'],
        ['editReply', { content: '🔎 Verarbeite: hello world', flags: SUPPRESS }],
        ['followUp', { content: '🔍 Suche nach Videos...', flags: SUPPRESS }],
        ['followUp', { ...ui.searchResultsMessage(results, 'u1'), flags: SUPPRESS }]
    ]));
    const cached = c.searchCache.get('u1');
    assert.deepEqual(cached.results, results);
    assert.equal(cached.messageId, i.messages.at(-1).id);
    assert.equal(cached.channelId, 'tc1');
    assert.equal(typeof cached.timestamp, 'number');

    const lastText = async (query, impl) => {
        searchImpl = impl;
        const j = fakeInteraction({ options: { query } });
        await CH.handlePlayCommand(ctx(j));
        return j.log.at(-1)[1].content;
    };
    assert.equal(await lastText('a{b}', async () => results),
        '❌ Ungültige Suchanfrage. Verwende nur alphanumerische Zeichen und Leerzeichen.');
    assert.equal(await lastText('song', async () => { throw new Error('Search timeout - try a more specific query'); }),
        '❌ Suche dauerte zu lange. Versuche einen spezifischeren Suchbegriff.');
    assert.equal(await lastText('song', async () => { throw new Error('exit 1'); }), '❌ Suche fehlgeschlagen: exit 1');
    assert.equal(await lastText('song', async () => []), '❌ Keine Ergebnisse gefunden.');
});

test('/select plays a cached search result and removes the results message', async () => {
    let i = fakeInteraction({ options: { number: 1 } });
    await CH.handleSelectCommand(ctx(i));
    assert.deepEqual(i.log, [['reply', '❌ Keine Suchergebnisse gefunden. Verwende zuerst `/play <suchbegriff>`.']]);

    const { guildId, queue } = newQueue('playing');
    const url = 'https://www.youtube.com/watch?v=ccccccccccc';
    const audioCache = fakeCache({ [url]: { filepath: path.join(TMP, 'sel.opus'), meta: { title: 'Gewählt*', duration: '2:22' } } });
    const searchMsg = fakeMessage(null);
    i = fakeInteraction({ guildId, options: { number: 3 } });
    const c = ctx(i, { audioCache });
    c.searchCache.set('u1', { results: [{ url, title: 'Gewählt*' }], messageId: 'search-1', channelId: 'tc9' });
    await CH.handleSelectCommand(c);
    assert.deepEqual(i.log, [['reply', '❌ Ungültige Nummer. Wähle zwischen 1 und 1.']]);

    i = fakeInteraction({ guildId, options: { number: 1 } });
    i.client.channels.cache.set('tc9', { messages: { fetch: async (id) => { assert.equal(id, 'search-1'); return searchMsg; } } });
    c.interaction = i;
    await CH.handleSelectCommand(c);
    assert.equal(searchMsg.deletes, 1);
    assert.equal(c.searchCache.get('u1'), null);
    assert.deepEqual(wire(i.log), wire([
        ['deferReply'],
        ['editReply', { content: '🎵 Spiele: **Gewählt\\***', flags: SUPPRESS }],
        ['followUp', { embeds: [ui.trackAddedEmbed({ title: 'Gewählt*', url, duration: '2:22', note: 'aus dem Cache — sofort verfügbar' })], flags: SUPPRESS }]
    ]));
    assert.equal(queue.songs.length, 1);
});

test('search_pick select menu: owner, staleness, invalid pick, success', async () => {
    const url = 'https://www.youtube.com/watch?v=ddddddddddd';
    const { guildId, queue } = newQueue('playing');
    const audioCache = fakeCache({ [url]: { filepath: path.join(TMP, 'pick.opus'), meta: { title: 'Pick', duration: '1:11' } } });
    const searchCache = ctx(null).searchCache;
    searchCache.set('u1', { results: [{ url, title: 'Pick' }], messageId: 'm-search' });
    const pick = async (opts) => {
        const i = fakeInteraction({ guildId, customId: 'search_pick|u1', ...opts });
        await CH.handleSearchSelect(ctx(i, { audioCache, searchCache }));
        return i.log;
    };

    assert.deepEqual(await pick({ userId: 'u2', values: ['1'], message: { id: 'm-search' } }),
        [['reply', { content: '❌ Das ist nicht deine Suche — starte selbst eine mit `/play`.', ephemeral: true }]]);
    assert.deepEqual(await pick({ values: ['1'], message: { id: 'm-old' } }),
        [['reply', { content: '❌ Diese Suche ist abgelaufen. Starte eine neue mit `/play <suchbegriff>`.', ephemeral: true }]]);
    assert.deepEqual(await pick({ values: ['5'], message: { id: 'm-search' } }),
        [['reply', { content: '❌ Ungültige Auswahl.', ephemeral: true }]]);

    const log = await pick({ values: ['1'], message: { id: 'm-search' } });
    assert.deepEqual(wire(log), wire([
        ['update', { content: '🎵 Spiele: **Pick**', embeds: [], components: [] }],
        ['followUp', { embeds: [ui.trackAddedEmbed({ title: 'Pick', url, duration: '1:11', note: 'aus dem Cache — sofort verfügbar' })], flags: SUPPRESS }]
    ]));
    assert.equal(searchCache.get('u1'), null);
    assert.equal(queue.songs[0].url, url);
});

// =============================== single track ===============================

test('direct URL: cache hit queues the cached file and kicks playback', async () => {
    const url = 'https://example.com/song.mp3';
    const fp = path.join(TMP, 'hit.opus');
    const { guildId, queue } = newQueue('playing');
    const audioCache = fakeCache({ [url]: { filepath: fp } });
    const i = fakeInteraction({ guildId, options: { query: url } });
    await CH.handlePlayCommand(ctx(i, { audioCache }));
    assert.deepEqual(queue.songs, [{ requesterId: 'u1', title: 'hit.opus', filepath: fp, url, duration: 'unbekannt' }]);
    assert.deepEqual(wire(i.log), wire([
        ['deferReply'],
        ['editReply', { content: `🔎 Verarbeite: ${url}`, flags: SUPPRESS }],
        ['followUp', { embeds: [ui.trackAddedEmbed({ title: 'hit.opus', url, duration: 'unbekannt', note: 'aus dem Cache — sofort verfügbar' })], flags: SUPPRESS }]
    ]));
    assert.deepEqual(ensureCalls, [[guildId, audioCache]]);
});

test('direct URL: YouTube links are cleaned, a missing queue is joined', async () => {
    const url = 'https://youtu.be/eeeeeeeeeee?si=tracking';
    const clean = 'https://www.youtube.com/watch?v=eeeeeeeeeee';
    const audioCache = fakeCache({ [clean]: { filepath: path.join(TMP, 'yt.opus'), meta: { title: 'YT', duration: '4:00' } } });
    const conn = fakeConn();
    joinImpl = async (channel) => { assert.deepEqual(channel, { id: 'vc1' }); return conn; };
    const i = fakeInteraction({ guildId: 'g-join', options: { query: url } });
    const c = ctx(i, { audioCache });
    await CH.handlePlayCommand(c);
    const queue = QM.guildQueues.get('g-join');
    assert.ok(queue);
    assert.equal(queue.connection, conn);
    assert.equal(conn.subscribed.length, 1);
    assert.equal(conn.subscribed[0], queue.player);
    assert.equal(queue.lastInteractionChannel, i.channel);
    assert.equal(queue.audioCache, audioCache);
    assert.equal(queue.songs[0].url, clean);

    joinImpl = async () => { throw new Error('Keine Berechtigung'); };
    const j = fakeInteraction({ guildId: 'g-join-2', options: { query: url } });
    await CH.handlePlayCommand(ctx(j, { audioCache }));
    assert.deepEqual(j.log.at(-1), ['followUp', { content: '❌ Keine Berechtigung', flags: SUPPRESS }]);
});

test('direct URL: fresh download reports progress, caches and cleans up its messages', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const url = 'https://example.com/fresh.mp3';
    const { guildId, queue } = newQueue('playing');
    const audioCache = fakeCache();
    videoInfoImpl = async () => ({ title: 'Frisch', duration: '2:00', url });
    let finish;
    downloadImpl = (fp, u, cb) => {
        assert.equal(u, url);
        assert.match(path.basename(fp), /^song_\d+_[0-9a-f]{8}\.opus$/);
        assert.equal(path.dirname(fp), DOWNLOADS);
        cb('[download]  50.0% of 3.00MiB at 1.00MiB/s ETA 00:02');
        return new Promise((resolve) => { finish = () => { fs.writeFileSync(fp, 'x'); resolve({ filepath: fp }); }; });
    };
    const i = fakeInteraction({ guildId, options: { query: url } });
    await CH.handlePlayCommand(ctx(i, { audioCache }));

    const track = queue.songs[0];
    assert.deepEqual({ ...track, _dlPromise: undefined }, { requesterId: 'u1', title: 'Frisch', filepath: null, url, duration: '2:00', _dlPromise: undefined });
    assert.ok(track._dlPromise instanceof Promise);
    assert.deepEqual(wire(i.log.slice(2)), wire([
        ['followUp', { embeds: [ui.downloadProgressEmbed({ title: 'Frisch', percent: 0 })], flags: SUPPRESS }]
    ]));

    finish();
    await settle();
    assert.equal(audioCache.sets.length, 1);
    assert.deepEqual(audioCache.sets[0].meta, { title: 'Frisch', duration: '2:00' });
    assert.equal(track.filepath, audioCache.sets[0].filepath);
    assert.equal(track._dlPromise, null);
    assert.deepEqual(wire(i.log.at(-1)), wire(['followUp', { embeds: [ui.trackAddedEmbed({ title: 'Frisch', url, duration: '2:00', note: 'Download abgeschlossen' })], flags: SUPPRESS }]));
    assert.deepEqual(ensureCalls, [[guildId, audioCache]]);

    const [progressMsg, finishMsg] = i.messages.slice(-2);
    assert.equal(progressMsg.deletes + finishMsg.deletes, 0);
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(progressMsg.deletes, 1);
    assert.equal(finishMsg.deletes, 1);
});

test('direct URL: failed download drops the track, kicks the queue and reports', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(logger, 'error', () => { });
    const url = 'https://example.com/broken.mp3';
    const { guildId, queue } = newQueue('playing');
    videoInfoImpl = async () => ({ title: 'Kaputt', duration: '1:00', url });
    downloadImpl = async () => { throw new Error('HTTP 403'); };
    queue._nextPrepared = true;
    const i = fakeInteraction({ guildId, options: { query: url } });
    const c = ctx(i);
    await CH.handlePlayCommand(c);
    await settle();
    assert.deepEqual(queue.songs, []);
    assert.equal(queue._nextPrepared, false);
    assert.deepEqual(ensureCalls, [[guildId, c.audioCache]]);
    assert.deepEqual(i.log.at(-1), ['followUp', { content: '❌ Download fehlgeschlagen: HTTP 403', flags: SUPPRESS }]);
    assert.deepEqual(logger.error.mock.calls.map(x => x.arguments[0]), ['[DOWNLOAD ERROR] HTTP 403']);
});

test('direct URL: queue limit and video-info failure', async (t) => {
    t.mock.method(logger, 'error', () => { });
    const url = 'https://example.com/more.mp3';
    let { guildId, queue } = newQueue('playing');
    queue.songs.push(...remoteSongs(500));
    let i = fakeInteraction({ guildId, options: { query: url } });
    await CH.handlePlayCommand(ctx(i));
    assert.deepEqual(i.log.at(-1), ['followUp', { content: '❌ Queue-Limit erreicht (max. 500 Songs).', flags: SUPPRESS }]);

    // Local mapping files do not count toward the limit
    queue.songs.length = 0;
    for (let n = 0; n < 600; n++) queue.songs.push({ title: 'l' + n, filepath: 'x', isLocalFile: true });
    videoInfoImpl = async () => { throw new Error('Video unavailable'); };
    i = fakeInteraction({ guildId, options: { query: url } });
    await CH.handlePlayCommand(ctx(i));
    assert.deepEqual(i.log.at(-1), ['followUp', { content: '❌ Konnte Video-Info nicht abrufen: Video unavailable', flags: SUPPRESS }]);
    assert.equal(queue.songs.length, 600);
});

// =============================== video+playlist choice ===============================

function choiceRow(singleId, playlistId, singleLabel, playlistLabel, disabled) {
    const button = (custom_id, label, style) => ({ type: 2, custom_id, label, style, ...(disabled ? { disabled: true } : {}) });
    return { type: 1, components: [button(singleId, singleLabel, 1), button(playlistId, playlistLabel, 2)] };
}

async function promptChoice(query, userId = 'u1') {
    const i = fakeInteraction({ userId, options: { query } });
    await CH.handlePlayCommand(ctx(i));
    const [via, payload] = i.log.at(-1);
    assert.equal(via, 'followUp');
    const key = payload.components[0].toJSON().components[0].custom_id.split('|')[1];
    return { i, payload, key, promptMsg: i.messages.at(-1) };
}

test('video+playlist URL asks which to play (playlist and Auto-Mix labels)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let { i, payload, key } = await promptChoice(`${VIDEO}&list=${PL_ID}`);
    assert.match(key, /^[0-9a-f]{8}$/);
    assert.deepEqual(i.log.slice(0, 2), [['deferReply'], ['editReply', { content: `🔎 Verarbeite: ${VIDEO}&list=${PL_ID}`, flags: SUPPRESS }]]);
    assert.deepEqual(wire(payload), {
        content: '🤔 Diese URL enthält ein Lied **und** eine Playlist. Was möchtest du abspielen?',
        components: [choiceRow(`play_single|${key}`, `play_playlist|${key}`, '🎵 Nur dieses Lied', '📋 Ganze Playlist', false)],
        flags: SUPPRESS
    });

    ({ payload, key } = await promptChoice(`${VIDEO}&list=RDabcdefghijk`));
    assert.deepEqual(wire(payload.components), [choiceRow(`play_single|${key}`, `play_playlist|${key}`, '🎵 Nur dieses Lied', '📻 Auto-Mix abspielen', false)]);
});

test('choice prompt auto-plays the single song after 15 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { guildId, queue } = newQueue('playing');
    const audioCache = fakeCache({ [VIDEO]: { filepath: path.join(TMP, 'auto.opus'), meta: { title: 'Auto', duration: '1:00' } } });
    const i = fakeInteraction({ guildId, options: { query: `${VIDEO}&list=RDabcdefghijk` } });
    await CH.handlePlayCommand(ctx(i, { audioCache }));
    const promptMsg = i.messages.at(-1);
    const key = i.log.at(-1)[1].components[0].toJSON().components[0].custom_id.split('|')[1];

    t.mock.timers.tick(14999);
    await settle();
    assert.equal(promptMsg.edits.length, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(wire(promptMsg.edits), [{
        content: '⏱️ Keine Auswahl getroffen — spiele nur das Lied.',
        components: [choiceRow('expired_single', 'expired_playlist', '🎵 Nur dieses Lied (auto)', '📻 Auto-Mix abspielen', true)]
    }]);
    assert.equal(queue.songs[0].url, VIDEO);

    // The choice is consumed: a late click is told it expired
    const late = fakeInteraction({ guildId, customId: `play_single|${key}` });
    await CH.handlePlaylistChoiceButton(ctx(late));
    assert.deepEqual(late.log, [['reply', { content: '⏱️ Diese Auswahl ist abgelaufen.', ephemeral: true }]]);
});

test('choice buttons: expired key, foreign user, play single', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { guildId, queue } = newQueue('playing');
    const audioCache = fakeCache({ [VIDEO]: { filepath: path.join(TMP, 'single.opus'), meta: { title: 'Single', duration: '3:33' } } });
    const { key } = await promptChoice(`${VIDEO}&list=${PL_ID}`);

    let i = fakeInteraction({ customId: 'play_single' });
    await CH.handlePlaylistChoiceButton(ctx(i));
    assert.deepEqual(i.log, []);

    i = fakeInteraction({ customId: 'play_single|00000000' });
    await CH.handlePlaylistChoiceButton(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '⏱️ Diese Auswahl ist abgelaufen.', ephemeral: true }]]);

    i = fakeInteraction({ guildId, userId: 'u2', customId: `play_single|${key}` });
    await CH.handlePlaylistChoiceButton(ctx(i));
    assert.deepEqual(i.log, [['reply', { content: '❌ Nur der ursprüngliche User kann diese Auswahl treffen.', ephemeral: true }]]);

    i = fakeInteraction({ guildId, customId: `play_single|${key}` });
    await CH.handlePlaylistChoiceButton(ctx(i, { audioCache }));
    assert.deepEqual(wire(i.log), wire([
        ['update', {
            content: '🎵 Spiele nur dieses Lied...',
            components: [choiceRow('done_single', 'done_playlist', '🎵 Nur dieses Lied', '📋 Ganze Playlist', true)]
        }],
        ['followUp', { embeds: [ui.trackAddedEmbed({ title: 'Single', url: VIDEO, duration: '3:33', note: 'aus dem Cache — sofort verfügbar' })], flags: SUPPRESS }]
    ]));
    assert.equal(queue.songs[0].url, VIDEO);
});

// =============================== playlists ===============================

const ENTRIES = [
    { url: 'https://www.youtube.com/watch?v=11111111111', title: 'One', duration: 60, thumbnail: 'https://img/1' },
    { url: null, title: 'No URL' },
    { url: 'https://www.youtube.com/watch?v=22222222222', title: 'Two', duration: 120, thumbnail: 'https://img/2' },
    { url: 'https://www.youtube.com/watch?v=33333333333', title: '', duration: null }
];
const firstCached = () => fakeCache({ [ENTRIES[2].url]: { filepath: path.join(TMP, 'two.opus'), meta: { title: 'Two', duration: '2:00' } } });

test('/play playlist: first track plays first, the rest is queued for background download', async () => {
    const url = `https://www.youtube.com/playlist?list=${PL_ID}&index=2`;
    playlistImpl = async (u) => { assert.equal(u, url); return { playlistTitle: 'Meine Liste', entries: ENTRIES }; };
    const { guildId, queue } = newQueue('playing');
    const audioCache = firstCached();
    const i = fakeInteraction({ guildId, options: { query: url } });
    const c = ctx(i, { audioCache });
    await CH.handlePlayCommand(c);

    const rest = [
        { requesterId: 'u1', title: 'Unbekannt', filepath: null, url: ENTRIES[3].url, duration: null, thumbnail: null, playlistTitle: 'Meine Liste' },
        { requesterId: 'u1', title: 'One', filepath: null, url: ENTRIES[0].url, duration: 60, thumbnail: 'https://img/1', playlistTitle: 'Meine Liste' }
    ];
    assert.deepEqual(queue.songs, [
        { requesterId: 'u1', title: 'Two', filepath: path.join(TMP, 'two.opus'), url: ENTRIES[2].url, duration: '2:00' },
        ...rest
    ]);
    assert.deepEqual(c.backgroundDownloader.added, rest.map(track => [guildId, track]));
    assert.equal(queue.playlistProgressMsg, i.messages[1]);
    assert.equal(typeof queue.lastProgressUpdate, 'number');
    assert.deepEqual(wire(i.log), wire([
        ['deferReply'],
        ['editReply', { content: `🔎 Verarbeite: ${url}`, flags: SUPPRESS }],
        ['followUp', { embeds: [ui.playlistProgressEmbed({ playlistTitle: 'Meine Liste', trackTitle: 'wird vorbereitet…', percent: 0, downloaded: 0, total: 2 })], flags: SUPPRESS }],
        ['followUp', { embeds: [ui.trackAddedEmbed({ title: 'Two', url: ENTRIES[2].url, duration: '2:00', note: 'aus dem Cache — sofort verfügbar' })], flags: SUPPRESS }],
        ['followUp', { embeds: [ui.playlistAddedEmbed({ playlistTitle: 'Meine Liste', added: 2, total: 2, startIndex: 1, limitReached: false, maxSongs: 500 })], flags: SUPPRESS }]
    ]));
    assert.deepEqual(ensureCalls, [[guildId, audioCache], [guildId, audioCache]]);
});

test('playlist button: same flow with its own track shape', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const choiceUrl = `${VIDEO}&list=${PL_ID}&index=2`;
    playlistImpl = async (u) => { assert.equal(u, choiceUrl); return { playlistTitle: 'Meine Liste', entries: ENTRIES }; };
    const { guildId, queue } = newQueue('playing');
    const { key } = await promptChoice(choiceUrl);
    const audioCache = firstCached();
    const i = fakeInteraction({ guildId, customId: `play_playlist|${key}` });
    const c = ctx(i, { audioCache });
    await CH.handlePlaylistChoiceButton(c);

    const rest = [
        { requesterId: 'u1', title: 'Unbekannt', url: ENTRIES[3].url, duration: null, filepath: null, playlistTitle: 'Meine Liste' },
        { requesterId: 'u1', title: 'One', url: ENTRIES[0].url, duration: 60, filepath: null, playlistTitle: 'Meine Liste' }
    ];
    assert.deepEqual(queue.songs.slice(1), rest);
    assert.equal(queue.songs[0].url, ENTRIES[2].url);
    assert.deepEqual(c.backgroundDownloader.added, rest.map(track => [guildId, track]));
    assert.deepEqual(wire(i.log), wire([
        ['update', { content: '📋 Lade Playlist...', components: [choiceRow('done_single', 'done_playlist', '🎵 Nur dieses Lied', '📋 Ganze Playlist', true)] }],
        ['followUp', { embeds: [ui.playlistProgressEmbed({ playlistTitle: 'Meine Liste', trackTitle: 'wird vorbereitet…', percent: 0, downloaded: 0, total: 2 })], flags: SUPPRESS }],
        ['followUp', { embeds: [ui.trackAddedEmbed({ title: 'Two', url: ENTRIES[2].url, duration: '2:00', note: 'aus dem Cache — sofort verfügbar' })], flags: SUPPRESS }],
        ['followUp', { embeds: [ui.playlistAddedEmbed({ playlistTitle: 'Meine Liste', added: 2, total: 2, startIndex: 1, limitReached: false, maxSongs: 500 })], flags: SUPPRESS }]
    ]));
    assert.equal(queue.playlistProgressMsg, i.messages[1]);
    assert.deepEqual(ensureCalls, [[guildId, audioCache], [guildId, audioCache]]);
});

test('playlist paths: read errors, empty playlists, join errors and the queue limit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const warned = t.mock.method(logger, 'warn', () => { });
    const errored = t.mock.method(logger, 'error', () => { });
    const plUrl = `https://www.youtube.com/playlist?list=${PL_ID}`;

    // /play path
    const viaPlay = async (guildId) => {
        const i = fakeInteraction({ guildId, options: { query: plUrl } });
        await CH.handlePlayCommand(ctx(i, { audioCache: firstCached() }));
        return i.log.at(-1);
    };
    // button path
    const viaButton = async (guildId) => {
        const { key } = await promptChoice(`${VIDEO}&list=${PL_ID}`);
        const i = fakeInteraction({ guildId, customId: `play_playlist|${key}` });
        await CH.handlePlaylistChoiceButton(ctx(i, { audioCache: firstCached() }));
        return i.log.at(-1);
    };

    const { guildId } = newQueue('playing');
    playlistImpl = async () => { throw new Error('private'); };
    assert.deepEqual(await viaPlay(guildId), ['followUp', { content: '⚠️ Playlist konnte nicht geladen werden: private', flags: SUPPRESS }]);
    assert.deepEqual(await viaButton(guildId), ['followUp', { content: '⚠️ Playlist konnte nicht geladen werden: private', flags: SUPPRESS }]);

    playlistImpl = async () => ({ playlistTitle: 'Leer', entries: [{ url: null }] });
    assert.deepEqual(await viaPlay(guildId), ['followUp', { content: 'Keine gültigen Einträge in der Playlist gefunden.', flags: SUPPRESS }]);
    assert.deepEqual(await viaButton(guildId), ['followUp', { content: 'Keine gültigen Einträge in der Playlist gefunden.', flags: SUPPRESS }]);

    joinImpl = async () => { throw new Error('Kanal voll'); };
    assert.deepEqual(await viaPlay('g-pl-nojoin'), ['followUp', { content: '❌ Kanal voll', flags: SUPPRESS }]);
    assert.deepEqual(await viaButton('g-pl-nojoin'), ['followUp', { content: '❌ Fehler: Kanal voll', flags: SUPPRESS }]);
    assert.deepEqual(errored.mock.calls.map(c => c.arguments[0]), ['[PLAYLIST BUTTON] Kanal voll']);
    joinImpl = async () => fakeConn();

    // Queue limit: the first track fills the last slot, nothing else fits
    playlistImpl = async () => ({ playlistTitle: 'Voll', entries: [ENTRIES[2], ENTRIES[0], ENTRIES[3]] });
    const fill = () => { const { guildId: g, queue } = newQueue('playing'); queue.songs.push(...remoteSongs(499)); return { g, queue }; };
    warned.mock.resetCalls();
    let { g, queue } = fill();
    const playLast = await viaPlay(g);
    assert.equal(queue.songs.length, 500);
    assert.deepEqual(wire(playLast), wire(['followUp', { embeds: [ui.playlistAddedEmbed({ playlistTitle: 'Voll', added: 0, total: 2, startIndex: 0, limitReached: true, maxSongs: 500 })], flags: SUPPRESS }]));
    ({ g, queue } = fill());
    const buttonLast = await viaButton(g);
    assert.equal(queue.songs.length, 500);
    assert.deepEqual(wire(buttonLast), wire(playLast));
    assert.deepEqual(warned.mock.calls.map(c => c.arguments[0]).filter(m => m.startsWith('[QUEUE LIMIT]')), [
        `[QUEUE LIMIT][guild-${guildN - 1}] Queue full at 500, skipping remaining playlist entries`,
        `[QUEUE LIMIT][guild-${guildN}] Queue full at 500`
    ]);
});
