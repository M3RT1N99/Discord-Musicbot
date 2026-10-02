'use strict';
// Regression guards for the code-review fixes F01-F14 (docs/code-review-2026-08-22.md).
// Runs fully offline: spawn and the yt-dlp wrappers are faked before the bot modules load.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbot-guards-'));
process.env.DOWNLOAD_DIR = TMP;
process.env.LOG_DIR = TMP;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

// ---- fakes that must exist BEFORE bot modules load (they destructure at require time)
const cp = require('child_process');
const spawned = [];
function fakeProc(cmd, args) {
    const p = new EventEmitter();
    p.cmd = cmd; p.args = args;
    p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.exitCode = null; p.signalCode = null; p.killed = false; p.kills = [];
    p.kill = (sig = 'SIGTERM') => { p.kills.push(sig); p.killed = true; return true; }; // mimics Node: killed = "signal sent"
    return p;
}
cp.spawn = (cmd, args) => { const p = fakeProc(cmd, args); spawned.push(p); return p; };

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}

const ytdlp = require(path.join(ROOT, 'src/download/ytdlp'));
const realDownloadSingleTo = ytdlp.downloadSingleTo;
const downloads = [];
ytdlp.downloadSingleTo = (fp, url) => {
    const d = deferred(); d.fp = fp; d.url = url;
    d.finish = () => { fs.writeFileSync(fp, 'audio'); d.resolve({ filepath: fp }); };
    downloads.push(d);
    return d.promise;
};
const defaultVideoInfo = async (url) => ({ title: 'T-' + url.slice(-4), duration: '1:00', url });
let videoInfoImpl = defaultVideoInfo;
ytdlp.getVideoInfo = (url) => videoInfoImpl(url);
let playlistEntries = [];
ytdlp.getPlaylistEntries = async () => ({ playlistTitle: 'PL', entries: playlistEntries });

const QM = require(path.join(ROOT, 'src/queue/QueueManager'));
const CH = require(path.join(ROOT, 'src/commands/commandHandlers'));

// ---- helpers
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
async function waitFor(pred, n = 400) { for (let i = 0; i < n && !pred(); i++) await new Promise(r => setImmediate(r)); return pred(); }
function fakePlayer(status = 'idle') {
    const p = new EventEmitter();
    p.state = { status }; p.plays = []; p.stopCalls = 0; p.unpauseCalls = 0;
    p.play = (r) => { p.plays.push(r); p.state = { status: 'playing', resource: r }; };
    p.stop = () => { p.stopCalls++; return true; };
    p.pause = () => { p.state = { status: 'paused' }; };
    p.unpause = () => { p.unpauseCalls++; };
    return p;
}
function fakeConn() {
    const c = new EventEmitter();
    c.state = { status: 'ready' }; c.destroyCalls = 0;
    c.destroy = () => { c.destroyCalls++; c.state = { status: 'destroyed' }; c.emit('destroyed'); };
    c.subscribe = () => { };
    return c;
}
let fileN = 0;
function audioFile(name) { const fp = path.join(TMP, `${name}-${fileN++}.opus`); fs.writeFileSync(fp, 'x'); return fp; }
const trk = (title, filepath = null, url = null) => ({ title, filepath, url, requesterId: 'u1' });
const yt = (id) => `https://www.youtube.com/watch?v=${(id + 'xxxxxxxxxxx').slice(0, 11)}`;
const PL = 'https://www.youtube.com/playlist?list=PL0123456789abcdefghij0123456789ab';

function fakeInteraction(guildId, query) {
    const sent = [];
    const msg = () => ({ id: 'm' + sent.length, edit: async () => { }, delete: async () => { } });
    return {
        sent, guildId, user: { id: 'u1', tag: 'u#1' }, member: { voice: { channel: { id: 'vc' } } }, channel: null,
        createdTimestamp: Date.now(), replied: false, deferred: false,
        options: { getString: () => query, getInteger: () => 1 },
        async deferReply() { this.deferred = true; },
        async editReply(p) { sent.push(p); return msg(); },
        async followUp(p) { sent.push(p); return msg(); },
        async reply(p) { this.replied = true; sent.push(p); return msg(); },
    };
}
function playCtx(interaction) {
    return {
        interaction, guildQueues: QM.guildQueues, createPlayerForGuild: QM.createPlayerForGuild, createGuildQueue: QM.createGuildQueue,
        audioCache: { has: () => false, get: () => null, getEntry: () => null, set: () => { } },
        searchCache: { set() { }, get() { return null; }, delete() { } },
        rateLimiter: { check: () => true },
        backgroundDownloader: { addToQueue() { }, processQueue() { } },
    };
}

// =============================== F01 ===============================
test('F01 two concurrent ensureNext calls advance the queue exactly once', async () => {
    const g = 'g01';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    const A = trk('A', audioFile('a')), B = trk('B', audioFile('b'));
    q.songs.push(A, B);
    const n0 = spawned.length;
    await Promise.all([QM.ensureNextTrackDownloadedAndPlay(g, null), QM.ensureNextTrackDownloadedAndPlay(g, null)]);
    await settle();
    assert.equal(spawned.length - n0, 1, 'ffmpeg spawned exactly once');
    assert.equal(q.currentTrack, A);
    assert.deepEqual(q.songs, [B]);
    assert.deepEqual(spawned.at(-1).kills, [], 'fresh ffmpeg not killed');
});

test('F01b a stale ffmpeg close does not clear the newer currentFfmpeg', async () => {
    const g = 'g01b';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    q.songs.push(trk('A', audioFile('a')), trk('B', audioFile('b')));
    await QM.ensureNextTrackDownloadedAndPlay(g, null); await settle();
    const ffA = q.currentFfmpeg;
    assert.ok(ffA);
    // A is superseded (e.g. skip during prebuffer) before its process has exited
    q.currentFfmpeg = null; ffA.kill('SIGTERM');
    await QM.ensureNextTrackDownloadedAndPlay(g, null); await settle();
    const ffB = q.currentFfmpeg;
    assert.ok(ffB && ffB !== ffA);
    ffA.emit('close', null);
    await settle();
    assert.equal(q.currentFfmpeg, ffB, 'busy marker of the newer ffmpeg survives');
});

test('F01c a throwing link does not poison the per-guild chain', async () => {
    const g = 'g01c';
    const player = fakePlayer('idle');
    const q = QM.createGuildQueue(g, fakeConn(), player, null);
    let first = true;
    Object.defineProperty(player, 'state', {
        configurable: true,
        get() { if (first) { first = false; throw new Error('boom'); } return { status: 'idle' }; },
        set() { }
    });
    q.songs.push(trk('A', audioFile('a')));
    await QM.ensureNextTrackDownloadedAndPlay(g, null).catch(() => { });
    await QM.ensureNextTrackDownloadedAndPlay(g, null);
    await settle();
    assert.equal(q.currentTrack?.title, 'A');
});

// =============================== F02 ===============================
test('F02 cleanupGuildResources destroys and deregisters the voice connection', () => {
    const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
    const adapterCreator = () => ({ sendPayload: () => true, destroy: () => { } });
    const g = 'g02';
    const conn = joinVoiceChannel({ channelId: 'c', guildId: g, adapterCreator });
    const player = QM.createPlayerForGuild(g, conn);
    conn.subscribe(player);
    QM.createGuildQueue(g, conn, player, null);
    QM.cleanupGuildResources(g); // path of the 15s disconnect timer
    assert.equal(conn.state.status, VoiceConnectionStatus.Destroyed);
    assert.equal(getVoiceConnection(g), undefined);
    const conn2 = joinVoiceChannel({ channelId: 'c', guildId: g, adapterCreator });
    assert.notEqual(conn2, conn, 'next join gets a fresh connection (no listener pile-up)');
    conn2.destroy();
});

test('F02b 15s disconnect timeout cleans up AND destroys the connection', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const g = 'g02b';
    const conn = fakeConn();
    const player = QM.createPlayerForGuild(g, conn);
    QM.createGuildQueue(g, conn, player, null);
    conn.state = { status: 'disconnected' };
    conn.emit('disconnected');
    t.mock.timers.tick(15000);
    assert.equal(QM.guildQueues.has(g), false);
    assert.equal(conn.destroyCalls, 1);
});

// =============================== F04 / F05 ===============================
test('F04 first playlist track keeps position 0, is downloaded once and plays first', async () => {
    const g = 'g04';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    playlistEntries = [{ url: yt('e1') }, { url: yt('e2') }, { url: yt('e3') }];
    const d0 = downloads.length;
    await CH.handlePlayCommand(playCtx(fakeInteraction(g, PL)));
    await settle();
    assert.deepEqual(q.songs.map(s => s.url), playlistEntries.map(e => e.url));
    const e1 = downloads.slice(d0).filter(d => d.url === playlistEntries[0].url);
    assert.equal(e1.length, 1, 'no duplicate download of track #1');
    const n0 = spawned.length;
    e1[0].finish();
    await settle(80);
    assert.equal(spawned.length - n0, 1);
    assert.equal(q.currentTrack?.url, playlistEntries[0].url);
});

test('F05 failed first-track download removes it and the queue gets kicked', async () => {
    const g = 'g05';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    playlistEntries = [{ url: yt('f1') }, { url: yt('f2') }, { url: yt('f3') }];
    const d0 = downloads.length;
    await CH.handlePlayCommand(playCtx(fakeInteraction(g, PL)));
    await settle();
    downloads.slice(d0).find(d => d.url === playlistEntries[0].url).reject(new Error('geo-blocked'));
    await settle(80);
    assert.ok(!q.songs.some(s => s.url === playlistEntries[0].url), 'failed track removed');
    assert.ok(downloads.slice(d0).some(d => d.url === playlistEntries[1].url), 'next track requested without another command');
});

test('F05b video-info failure of the first track still kicks the playlist', async () => {
    const g = 'g05b';
    QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    playlistEntries = [{ url: yt('h1') }, { url: yt('h2') }];
    videoInfoImpl = async () => { throw new Error('private video'); };
    const d0 = downloads.length;
    try {
        await CH.handlePlayCommand(playCtx(fakeInteraction(g, PL)));
        await settle(80);
    } finally { videoInfoImpl = defaultVideoInfo; }
    assert.ok(downloads.slice(d0).some(d => d.url === playlistEntries[1].url), 'playback kicked');
});

// =============================== F06 ===============================
test('F06 stale lazy-download success does not touch the replacement queue', async () => {
    const g = 'g06';
    const q1 = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    q1.songs.push(trk('OLD', null, yt('old1')));
    const d0 = downloads.length;
    const p1 = QM.ensureNextTrackDownloadedAndPlay(g, null);
    await settle();
    assert.equal(downloads.length - d0, 1, 'lazy download started');
    QM.deleteGuildQueue(g); // /stop
    const q2 = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null); // /play
    const N1 = trk('N1', null, yt('new1')), N2 = trk('N2', audioFile('n2'));
    q2.songs.push(N1, N2);
    const n0 = spawned.length;
    downloads[d0].finish();
    await p1; await settle();
    assert.deepEqual(q2.songs, [N1, N2]);
    assert.equal(spawned.length, n0);
    assert.equal(q2.player.plays.length, 0);
});

test('F06b stale lazy-download failure neither mutates nor retries into the replacement queue', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const g = 'g06b';
    const q1 = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    q1.songs.push(trk('OLD', null, yt('old2')));
    const d0 = downloads.length;
    const p1 = QM.ensureNextTrackDownloadedAndPlay(g, null);
    await settle();
    QM.deleteGuildQueue(g);
    const q2 = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    const N1 = trk('N1', null, yt('new2'));
    q2.songs.push(N1);
    downloads[d0].reject(new Error('boom'));
    await p1; await settle();
    t.mock.timers.tick(1000);
    await settle();
    assert.deepEqual(q2.songs, [N1]);
    assert.equal(q2.consecutiveErrors, 0);
    assert.ok(!downloads.slice(d0 + 1).some(d => d.url === N1.url), 'no retry scheduled against the new queue');
});

// =============================== F07 ===============================
test('F07 SIGKILL fallback fires 5s after SIGTERM while ffmpeg is still alive', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const g = 'g07';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('playing'), null);
    const ff = fakeProc('ffmpeg', []);
    q.currentFfmpeg = ff;
    QM.skipCurrentTrack(g);
    assert.deepEqual(ff.kills, ['SIGTERM']);
    t.mock.timers.tick(5000);
    assert.deepEqual(ff.kills, ['SIGTERM', 'SIGKILL']);
});

test('F07b no SIGKILL once ffmpeg has exited', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const g = 'g07b';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('playing'), null);
    const ff = fakeProc('ffmpeg', []);
    q.currentFfmpeg = ff;
    QM.skipCurrentTrack(g);
    ff.signalCode = 'SIGTERM';
    t.mock.timers.tick(5000);
    assert.deepEqual(ff.kills, ['SIGTERM']);
});

// =============================== F08 ===============================
test('F08 failed download (non-zero exit) removes target and .part', async () => {
    const fp = path.join(TMP, 'song_1_deadbee1.opus');
    fs.writeFileSync(fp, 'p'); fs.writeFileSync(fp + '.part', 'p');
    const pr = realDownloadSingleTo(fp, yt('dl1'), null);
    spawned.at(-1).emit('close', 1);
    await assert.rejects(pr);
    assert.ok(await waitFor(() => !fs.existsSync(fp) && !fs.existsSync(fp + '.part')), 'partial files removed');
});

test('F08b download timeout kills yt-dlp and removes partial files', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { DOWNLOAD_TIMEOUT_MS } = require(path.join(ROOT, 'src/config/constants'));
    const fp = path.join(TMP, 'song_2_deadbee2.opus');
    fs.writeFileSync(fp + '.part', 'p');
    const pr = realDownloadSingleTo(fp, yt('dl2'), null);
    const proc = spawned.at(-1);
    t.mock.timers.tick(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(pr, /timeout/i);
    assert.deepEqual(proc.kills, ['SIGKILL']);
    assert.ok(await waitFor(() => !fs.existsSync(fp + '.part')), '.part removed');
});

test('F08c spawn error removes partial files', async () => {
    const fp = path.join(TMP, 'song_3_deadbee3.opus');
    fs.writeFileSync(fp + '.part', 'p');
    const pr = realDownloadSingleTo(fp, yt('dl3'), null);
    spawned.at(-1).emit('error', Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }));
    await assert.rejects(pr);
    assert.ok(await waitFor(() => !fs.existsSync(fp + '.part')), '.part removed');
});

// =============================== F09 ===============================
test('F09 LRU eviction skips files referenced by a queue; hits refresh ts', async () => {
    const AudioCache = require(path.join(ROOT, 'src/cache/AudioCache'));
    const dir = fs.mkdtempSync(path.join(TMP, 'cache-'));
    const cache = new AudioCache(5, dir);
    const files = [...Array(7)].map((_, i) => { const f = path.join(dir, `f${i}.opus`); fs.writeFileSync(f, 'x'); return f; });
    const url = (i) => `https://example.com/${i}.mp3`;
    for (let i = 0; i < 5; i++) { cache.set(url(i), files[i]); cache.getEntry(url(i)).ts = 1000 + i; }
    cache.setInUseChecker(fp => fp === files[0]);
    cache.get(url(1)); // hit -> url(1) becomes most recent
    cache.set(url(5), files[5]);
    await settle();
    assert.ok(cache.getEntry(url(0)) && fs.existsSync(files[0]), 'in-use file kept');
    assert.ok(cache.getEntry(url(1)), 'recently hit entry kept');
    assert.equal(cache.getEntry(url(2)), null, 'oldest non-protected entry evicted');
    assert.equal(cache.getEntry(url(5))?.filepath, files[5], 'new entry never evicted');
    if (cache.saveTimer) clearTimeout(cache.saveTimer);
});

// =============================== F10 ===============================
test('F10 /queue reply stays within Discord limits for a huge queue', async () => {
    const g = 'g10';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('playing'), null);
    const long = '*_'.repeat(128); // markdown chars double under escaping
    q.currentTrack = { title: long, url: 'https://example.com/' + 'a'.repeat(2000), duration: 3600 };
    for (let i = 0; i < 500; i++) q.songs.push({ title: long, duration: '10:00', playlistTitle: 'P'.repeat(150), url: yt('q' + i) });
    let payload;
    const interaction = { guildId: g, reply: async (p) => { payload = p; } };
    await CH.handleQueueCommand({ interaction, guildQueues: QM.guildQueues });
    const content = typeof payload === 'string' ? payload : payload?.content;
    if (content) assert.ok(content.length <= 2000, `content ${content.length} > 2000`);
    for (const e of (payload?.embeds || [])) {
        const j = typeof e.toJSON === 'function' ? e.toJSON() : e;
        const total = (j.title || '').length + (j.description || '').length + (j.footer?.text || '').length +
            (j.author?.name || '').length + (j.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
        assert.ok((j.description || '').length <= 4096, 'description <= 4096');
        assert.ok(total <= 6000, 'embed total <= 6000');
    }
});

// =============================== F11 ===============================
test('F11 joining a stage channel requests unsuppress, non-blocking; plain voice does not', async () => {
    const { ChannelType } = require('discord.js');
    const VM = require(path.join(ROOT, 'src/voice/VoiceManager'));
    const mk = (gid, type, setSuppressed) => {
        const guild = {
            id: gid, name: 'G', voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() { } }),
            members: { me: { voice: { channelId: 'ch-' + gid, setSuppressed } } }
        };
        return { id: 'ch-' + gid, name: 'C', type, guild, permissionsFor: () => ({ has: () => true }) };
    };
    const calls = [];
    const never = new Promise(() => { });
    const c1 = await VM.joinVoiceChannelWithRetry(mk('g11a', ChannelType.GuildStageVoice, (v) => { calls.push(v); return never; }));
    assert.deepEqual(calls, [false], 'unsuppress requested; join did not wait for it');
    const plainCalls = [];
    const c2 = await VM.joinVoiceChannelWithRetry(mk('g11b', ChannelType.GuildVoice, (v) => { plainCalls.push(v); }));
    await settle();
    assert.deepEqual(plainCalls, []);
    c1.destroy(); c2.destroy();
});

// =============================== F12 ===============================
for (const status of ['paused', 'autopaused', 'buffering', 'playing']) {
    test(`F12 no advance and no teardown while player is ${status}`, async () => {
        const g = 'g12' + status;
        const conn = fakeConn();
        const q = QM.createGuildQueue(g, conn, fakePlayer(status), null);
        q.currentTrack = trk('cur', audioFile('c'));
        q.songs.push(trk('N', audioFile('n')));
        const n0 = spawned.length;
        await QM.ensureNextTrackDownloadedAndPlay(g, null); await settle();
        assert.equal(spawned.length, n0);
        assert.equal(q.songs.length, 1);
        assert.equal(q.currentTrack.title, 'cur');
        q.songs.length = 0; // current track shifted out, still playing/paused
        await QM.ensureNextTrackDownloadedAndPlay(g, null); await settle();
        assert.equal(QM.guildQueues.get(g), q, 'queue not torn down');
        assert.equal(conn.destroyCalls, 0);
    });
}

test('F12b playNextInGuild itself refuses to replace a paused resource', () => {
    const g = 'g12b';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('paused'), null);
    q.songs.push(trk('N', audioFile('n')));
    const n0 = spawned.length;
    QM.playNextInGuild(g);
    assert.equal(spawned.length, n0);
    assert.equal(q.songs.length, 1);
});

// =============================== F14 ===============================
test('F14 np_prev under shuffle plays exactly the previous track', async (t) => {
    t.mock.method(Math, 'random', () => 0.999);
    const g = 'g14';
    const player = fakePlayer('playing');
    const q = QM.createGuildQueue(g, fakeConn(), player, null);
    q.shuffle = true;
    const P = trk('P', audioFile('p')), X = trk('X', audioFile('x'));
    q.previousTrack = P; q.currentTrack = X;
    for (let i = 0; i < 8; i++) q.songs.push(trk('S' + i, audioFile('s' + i)));
    const interaction = { customId: `np_prev|${g}`, deferUpdate: async () => { }, reply: async () => { } };
    await CH.handleNowPlayingButton({ interaction, guildQueues: QM.guildQueues });
    assert.equal(q.songs[0], P); assert.equal(q.songs[1], X);
    player.state = { status: 'idle' }; // Idle after player.stop()
    await QM.ensureNextTrackDownloadedAndPlay(g, null); await settle();
    assert.equal(q.currentTrack, P);
    assert.ok(spawned.at(-1).args.includes(P.filepath));
});

test('F14b np_prev while idle (no ffmpeg) plays previous and drops nothing', async () => {
    const g = 'g14b';
    const q = QM.createGuildQueue(g, fakeConn(), fakePlayer('idle'), null);
    const P = trk('P', audioFile('p')), X = trk('X', audioFile('x')), S = trk('S', audioFile('s'));
    q.previousTrack = P; q.currentTrack = X; q.songs.push(S);
    const n0 = spawned.length;
    const interaction = { customId: `np_prev|${g}`, deferUpdate: async () => { }, reply: async () => { } };
    await CH.handleNowPlayingButton({ interaction, guildQueues: QM.guildQueues });
    await settle();
    assert.equal(spawned.length - n0, 1);
    assert.equal(q.currentTrack, P);
    assert.deepEqual(q.songs, [X, S]);
});

// =============================== F13 ===============================
test('F13 URL blocklist is hostname-anchored (blocks SSRF, no false positives)', () => {
    const { validateUrl } = require(path.join(ROOT, 'src/utils/validation'));
    const blocked = ['http://localhost/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://10.0.0.5/',
        'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/', 'http://0.0.0.0/', 'http://[::1]:8080/',
        'http://[fd00::1]/', 'http://nas-admin.lan:8080/api/status', 'http://tower/', 'http://printer.local:631/',
        'http://svc.internal:9000/', 'http://foo.home.arpa/', 'file:///etc/passwd', 'ftp://example.com/'];
    const allowed = ['https://archive.org/download/album/track-10.mp3', 'https://www.youtube.com/watch?v=abc&start=10.5',
        'https://example.com/192.168.1.1/x', 'https://172.32.0.1/a', 'https://audiomack.com/artist/song/x'];
    for (const u of blocked) assert.equal(validateUrl(u), false, `must block ${u}`);
    for (const u of allowed) assert.equal(validateUrl(u), true, `must allow ${u}`);
});
