'use strict';
// Characterization of the src/index.js wiring: slash-command registration,
// gateway events, interaction routing and the shared handler context.
// Runs offline: REST.put is captured and the client never logs in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbot-index-'));
process.env.DOWNLOAD_DIR = TMP;
process.env.LOG_DIR = TMP;
process.env.LOG_LEVEL = 'error';
process.env.TOKEN = 'test-token';
process.env.LOCAL_MUSIC_DIR = path.join(TMP, 'music');
fs.mkdirSync(path.join(TMP, 'music', 'Album'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'music', 'Album', 'song.mp3'), 'x');

const { REST } = require('discord.js');
const restCalls = [];
REST.prototype.put = async function (route, opts) {
    restCalls.push({ route, body: opts.body });
    return [];
};

// Spies must be installed BEFORE index.js destructures its imports
const QM = require('../src/queue/QueueManager');
const deletedGuilds = [];
QM.deleteGuildQueue = (guildId) => { deletedGuilds.push(guildId); };

const CH = require('../src/commands/commandHandlers');
const HANDLER_NAMES = [
    'handlePlayCommand', 'handleSelectCommand', 'handleSearchSelect', 'handlePauseCommand',
    'handleResumeCommand', 'handleSkipCommand', 'handleStopCommand', 'handleQueueCommand',
    'handleVolumeCommand', 'handleLeaveCommand', 'handleShuffleCommand', 'handleTestCommand',
    'handleDebugCommand', 'handlePlaycacheCommand', 'handlePlayLocalMusicCommand', 'handleRefreshCommand',
    'handleClearcacheCommand', 'handleRepeatSingleCommand', 'handleRepeatCommand',
    'handlePlaylistChoiceButton', 'handleNowPlayingButton', 'handlePlayLocalMusicAutocomplete'
];
const handlerCalls = [];
let throwFrom = null;
for (const name of HANDLER_NAMES) {
    CH[name] = async (context) => {
        handlerCalls.push({ name, context });
        if (throwFrom === name) throw new Error('boom');
    };
}

const bot = require('../src/index.js');
const { client } = bot;
const EXPECTED_COMMANDS = require('./fixtures/slash-commands.json');

const CONTEXT_KEYS = [
    'interaction', 'audioCache', 'searchCache', 'rateLimiter', 'backgroundDownloader', 'localMusic', 'guildQueues',
    'createPlayerForGuild', 'createGuildQueue', 'deleteGuildQueue', 'commandBuilders', 'logger'
];

// Compare what goes over the wire (undefined keys are dropped by JSON)
const wire = (value) => JSON.parse(JSON.stringify(value));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function fakeInteraction(kind, props = {}) {
    const replies = [];
    return {
        replies,
        guildId: 'g1',
        user: { id: 'u1', tag: 'u#0001' },
        replied: false,
        deferred: false,
        isButton: () => kind === 'button',
        isStringSelectMenu: () => kind === 'select',
        isChatInputCommand: () => kind === 'command',
        isAutocomplete: () => kind === 'autocomplete',
        async reply(p) { replies.push({ via: 'reply', payload: p }); },
        async followUp(p) { replies.push({ via: 'followUp', payload: p }); },
        ...props
    };
}

async function dispatch(interaction) {
    handlerCalls.length = 0;
    client.emit('interactionCreate', interaction);
    await settle();
    return handlerCalls.map(c => c.name);
}

test('commandHandlers barrel exports the 22 handlers in order', () => {
    assert.deepEqual(Object.keys(CH), HANDLER_NAMES);
});

test('clientReady clears global commands, then registers the commands per guild', async () => {
    client.application = { id: 'app1' };
    client.user = { tag: 'bot#0001' };
    client.guilds.cache.set('g1', { id: 'g1', name: 'Guild One' });
    client.guilds.cache.set('g2', { id: 'g2', name: 'Guild Two' });

    client.emit('clientReady');
    const warmup = bot.localMusic.scanning;
    assert.ok(warmup, 'library index scan started on ready');
    await warmup;
    await settle();
    assert.deepEqual(bot.localMusic.folders.map(f => f.relPath), ['Album']);

    assert.deepEqual(restCalls.map(c => c.route), [
        '/applications/app1/commands',
        '/applications/app1/guilds/g1/commands',
        '/applications/app1/guilds/g2/commands'
    ]);
    assert.deepEqual(restCalls[0].body, []);
    assert.deepEqual(wire(restCalls[1].body), EXPECTED_COMMANDS);
    assert.deepEqual(wire(restCalls[2].body), EXPECTED_COMMANDS);
});

test('guildCreate registers the commands for the new guild', async () => {
    restCalls.length = 0;
    client.emit('guildCreate', { id: 'g3', name: 'Guild Three' });
    await settle();

    assert.deepEqual(restCalls.map(c => c.route), ['/applications/app1/guilds/g3/commands']);
    assert.deepEqual(wire(restCalls[0].body), EXPECTED_COMMANDS);
});

test('guildDelete tears down the guild queue', async () => {
    deletedGuilds.length = 0;
    client.emit('guildDelete', { id: 'g4', name: 'Guild Four' });
    assert.deepEqual(deletedGuilds, ['g4']);
});

test('voiceStateUpdate tears down only when the last human leaves the bot channel', () => {
    const members = (...bots) => ({ filter: (fn) => ({ size: bots.map(bot => ({ user: { bot } })).filter(fn).length }) });
    const state = (channel, botChannel) => ({
        channel,
        guild: { id: 'g5', name: 'Guild Five', members: { me: { voice: { channel: botChannel } } } }
    });
    const vc = { id: 'vc1', members: members(true) };

    deletedGuilds.length = 0;
    client.emit('voiceStateUpdate', state(null, vc), {});                                   // joined, not left
    client.emit('voiceStateUpdate', state(vc, null), {});                                   // bot not in voice
    client.emit('voiceStateUpdate', state({ id: 'other', members: members() }, vc), {});    // other channel
    client.emit('voiceStateUpdate', state({ id: 'vc1', members: members(true, false) }, vc), {}); // human left behind
    assert.deepEqual(deletedGuilds, []);

    client.emit('voiceStateUpdate', state(vc, vc), {});                                     // only bots remain
    assert.deepEqual(deletedGuilds, ['g5']);
});

test('chat input commands route to their handler with the shared context', async () => {
    const routes = {
        play: 'handlePlayCommand', select: 'handleSelectCommand', pause: 'handlePauseCommand',
        resume: 'handleResumeCommand', skip: 'handleSkipCommand', stop: 'handleStopCommand',
        queue: 'handleQueueCommand', volume: 'handleVolumeCommand', leave: 'handleLeaveCommand',
        shuffle: 'handleShuffleCommand', test: 'handleTestCommand', debug: 'handleDebugCommand',
        playcache: 'handlePlaycacheCommand', playlocalmusic: 'handlePlayLocalMusicCommand',
        refresh: 'handleRefreshCommand', clearcache: 'handleClearcacheCommand',
        repeatsingle: 'handleRepeatSingleCommand', repeat: 'handleRepeatCommand'
    };
    for (const [commandName, handler] of Object.entries(routes)) {
        const interaction = fakeInteraction('command', { commandName });
        assert.deepEqual(await dispatch(interaction), [handler], commandName);

        const { context } = handlerCalls[0];
        assert.deepEqual(Object.keys(context), CONTEXT_KEYS);
        assert.equal(context.interaction, interaction);
        assert.equal(context.audioCache, bot.audioCache);
        assert.equal(context.searchCache, bot.searchCache);
        assert.equal(context.rateLimiter, bot.rateLimiter);
        assert.equal(context.backgroundDownloader, bot.backgroundDownloader);
        assert.equal(context.localMusic, bot.localMusic);
        assert.equal(context.guildQueues, bot.guildQueues);
        assert.equal(context.guildQueues, QM.guildQueues);
        assert.equal(context.createPlayerForGuild, QM.createPlayerForGuild);
        assert.equal(context.createGuildQueue, QM.createGuildQueue);
        assert.equal(typeof context.deleteGuildQueue, 'function');
        assert.equal(context.logger, require('../src/utils/logger'));
        assert.deepEqual(wire(context.commandBuilders.map(b => b.toJSON())), EXPECTED_COMMANDS);
        assert.deepEqual(interaction.replies, []);
    }
});

test('buttons and select menus route by customId prefix', async () => {
    const cases = [
        ['button', 'play_single|abc', ['handlePlaylistChoiceButton']],
        ['button', 'play_playlist|abc', ['handlePlaylistChoiceButton']],
        ['button', 'np_skip|g1', ['handleNowPlayingButton']],
        ['button', 'expired_single', []],
        ['select', 'search_pick|u1', ['handleSearchSelect']],
        ['select', 'other_menu', []],
        ['other', 'whatever', []]
    ];
    for (const [kind, customId, expected] of cases) {
        const interaction = fakeInteraction(kind, { customId, commandName: 'play' });
        assert.deepEqual(await dispatch(interaction), expected, `${kind} ${customId}`);
        if (expected.length) assert.deepEqual(Object.keys(handlerCalls[0].context), CONTEXT_KEYS);
        assert.deepEqual(interaction.replies, []);
    }
});

test('autocomplete requests route to the /playlocalmusic folder picker only', async () => {
    const ours = fakeInteraction('autocomplete', { commandName: 'playlocalmusic' });
    assert.deepEqual(await dispatch(ours), ['handlePlayLocalMusicAutocomplete']);
    assert.deepEqual(Object.keys(handlerCalls[0].context), CONTEXT_KEYS);
    assert.equal(handlerCalls[0].context.localMusic, bot.localMusic);
    assert.deepEqual(ours.replies, []);

    const other = fakeInteraction('autocomplete', { commandName: 'play' });
    assert.deepEqual(await dispatch(other), []);
    assert.deepEqual(other.replies, []);
});

test('a throwing autocomplete handler is logged, not answered', async (t) => {
    const logged = t.mock.method(require('../src/utils/logger'), 'error', () => { });
    throwFrom = 'handlePlayLocalMusicAutocomplete';
    try {
        const interaction = fakeInteraction('autocomplete', { commandName: 'playlocalmusic' });
        assert.deepEqual(await dispatch(interaction), ['handlePlayLocalMusicAutocomplete']);
        assert.deepEqual(interaction.replies, []);
        assert.equal(logged.mock.calls.at(-1).arguments[0], '[AUTOCOMPLETE ERROR] boom');
    } finally {
        throwFrom = null;
    }
});

test('unknown commands get an ephemeral "Unknown command" reply', async () => {
    const interaction = fakeInteraction('command', { commandName: 'nope' });
    assert.deepEqual(await dispatch(interaction), []);
    assert.deepEqual(interaction.replies, [{ via: 'reply', payload: { content: 'Unknown command', ephemeral: true } }]);
});

test('a throwing command handler gets the generic error reply (reply or followUp)', async (t) => {
    const logged = t.mock.method(require('../src/utils/logger'), 'error', () => { });
    const errorPayload = { content: '❌ Ein Fehler ist aufgetreten. Bitte versuche es erneut.', ephemeral: true };
    throwFrom = 'handlePauseCommand';
    try {
        const fresh = fakeInteraction('command', { commandName: 'pause' });
        await dispatch(fresh);
        assert.deepEqual(fresh.replies, [{ via: 'reply', payload: errorPayload }]);

        const deferred = fakeInteraction('command', { commandName: 'pause', deferred: true });
        await dispatch(deferred);
        assert.deepEqual(deferred.replies, [{ via: 'followUp', payload: errorPayload }]);

        const replied = fakeInteraction('command', { commandName: 'pause', replied: true });
        await dispatch(replied);
        assert.deepEqual(replied.replies, [{ via: 'followUp', payload: errorPayload }]);
        assert.deepEqual(logged.mock.calls.map(c => c.arguments[0]), Array(3).fill('[COMMAND ERROR] pause:'));
        assert.ok(logged.mock.calls.every(c => c.arguments[1]?.message === 'boom'));
    } finally {
        throwFrom = null;
    }
});

test('throwing button / select handlers are logged, not answered', async (t) => {
    const logged = t.mock.method(require('../src/utils/logger'), 'error', () => { });
    const cases = [
        ['button', 'play_single|abc', 'handlePlaylistChoiceButton', '[BUTTON ERROR] boom'],
        ['button', 'np_pause|g1', 'handleNowPlayingButton', '[NP BUTTON ERROR] boom'],
        ['select', 'search_pick|u1', 'handleSearchSelect', '[SELECT MENU ERROR] boom']
    ];
    for (const [kind, customId, handler, logLine] of cases) {
        throwFrom = handler;
        try {
            const interaction = fakeInteraction(kind, { customId });
            assert.deepEqual(await dispatch(interaction), [handler]);
            assert.deepEqual(interaction.replies, []);
            assert.equal(logged.mock.calls.at(-1).arguments[0], logLine);
        } finally {
            throwFrom = null;
        }
    }
});

test('audio cache treats files referenced by any queue as in use', () => {
    const fp = (name) => path.join(TMP, name);
    bot.guildQueues.set('g6', {
        currentTrack: { filepath: fp('current.opus') },
        previousTrack: { filepath: fp('previous.opus') },
        songs: [{ filepath: fp('queued.opus') }, { filepath: null }]
    });
    try {
        assert.equal(bot.audioCache.isInUse(fp('current.opus')), true);
        assert.equal(bot.audioCache.isInUse(fp('previous.opus')), true);
        assert.equal(bot.audioCache.isInUse(fp('queued.opus')), true);
        assert.equal(bot.audioCache.isInUse(fp('other.opus')), false);
    } finally {
        bot.guildQueues.delete('g6');
    }
});
