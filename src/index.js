// src/index.js
// Main entry point for Discord Musicbot: creates the shared services, registers
// the slash commands and routes interactions to the handlers in src/commands/

const { Client, GatewayIntentBits } = require('discord.js');
const { TOKEN, DOWNLOAD_DIR } = require('./config/constants');
const logger = require('./utils/logger');
const AudioCache = require('./cache/AudioCache');
const SearchCache = require('./cache/SearchCache');
const BackgroundDownloader = require('./download/BackgroundDownloader');
const RateLimiter = require('./download/RateLimiter');
const {
    guildQueues,
    createPlayerForGuild,
    createGuildQueue,
    deleteGuildQueue
} = require('./queue/QueueManager');
const { startStatusFiles } = require('./runtime/statusFiles');
const { installShutdownHandlers } = require('./runtime/shutdown');

// Initialize global instances
const audioCache = new AudioCache(undefined, DOWNLOAD_DIR);
const searchCache = new SearchCache();
const rateLimiter = new RateLimiter();
const backgroundDownloader = new BackgroundDownloader(audioCache, () => guildQueues);

// Protect files still referenced by any guild queue from cache eviction
audioCache.setInUseChecker((filepath) => {
    for (const q of guildQueues.values()) {
        if (q.currentTrack?.filepath === filepath || q.previousTrack?.filepath === filepath) return true;
        if (q.songs.some(s => s.filepath === filepath)) return true;
    }
    return false;
});

// Log startup
logger.info('='.repeat(60));
logger.info('🎵 Discord Musicbot Starting...');
logger.info('='.repeat(60));

const {
    handlePlayCommand,
    handleSelectCommand,
    handleSearchSelect,
    handlePauseCommand,
    handleResumeCommand,
    handleSkipCommand,
    handleStopCommand,
    handleQueueCommand,
    handleVolumeCommand,
    handleLeaveCommand,
    handleShuffleCommand,
    handleTestCommand,
    handleDebugCommand,
    handlePlaycacheCommand,
    handlePlaychristCommand,
    handleRefreshCommand,
    handleClearcacheCommand,
    handleRepeatSingleCommand,
    handleRepeatCommand,
    handlePlaylistChoiceButton,
    handleNowPlayingButton
} = require('./commands/commandHandlers');
const { commandBuilders } = require('./commands/definitions');
const { createCommandRest, commandsToJson, clearGlobalCommands, putGuildCommands } = require('./commands/registration');

// Slash command name -> handler
const commandHandlers = new Map([
    ['play', handlePlayCommand],
    ['select', handleSelectCommand],
    ['pause', handlePauseCommand],
    ['resume', handleResumeCommand],
    ['skip', handleSkipCommand],
    ['stop', handleStopCommand],
    ['queue', handleQueueCommand],
    ['volume', handleVolumeCommand],
    ['leave', handleLeaveCommand],
    ['shuffle', handleShuffleCommand],
    ['test', handleTestCommand],
    ['debug', handleDebugCommand],
    ['playcache', handlePlaycacheCommand],
    ['playchrist', handlePlaychristCommand],
    ['refresh', handleRefreshCommand],
    ['clearcache', handleClearcacheCommand],
    ['repeatsingle', handleRepeatSingleCommand],
    ['repeat', handleRepeatCommand]
]);

/**
 * Context object every interaction handler receives
 * @param {Interaction} interaction - Discord interaction
 * @returns {object} Handler context
 */
function createContext(interaction) {
    return {
        interaction,
        audioCache,
        searchCache,
        rateLimiter,
        backgroundDownloader,
        guildQueues,
        createPlayerForGuild,
        createGuildQueue,
        deleteGuildQueue,
        commandBuilders,
        logger
    };
}

// --------------------------- Discord Client Setup ---------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    // Bot messages echo user-controlled video titles — never let them ping
    allowedMentions: { parse: [], repliedUser: false }
});

/**
 * Debug heartbeat every 30s (memory, queues, background downloads) to diagnose lag
 */
function startHeartbeatLogger() {
    setInterval(() => {
        const memory = process.memoryUsage();
        const activeQueues = guildQueues.size;
        const bgStats = backgroundDownloader.getStats();

        logger.debug(`[HEARTBEAT] Memory: ${Math.round(memory.rss / 1024 / 1024)}MB RSS, ${Math.round(memory.heapUsed / 1024 / 1024)}MB Heap | Queues: ${activeQueues} | BG-Downloads: ${bgStats.isActive ? 'Active' : 'Idle'} (${bgStats.queueLength} pending)`);

        // Log specific guild states if active (snapshot to avoid concurrent modification)
        for (const [guildId, q] of [...guildQueues]) {
            if (q.player.state.status === 'playing') {
                const buffering = q.currentFfmpeg ? 'Buffering' : 'Ready';
                logger.debug(`[STATUS][${logger.guildTag(guildId)}] Playing: ${q.currentTrack?.title?.substring(0, 30)}... | State: ${buffering}`);
            }
        }
    }, 30000).unref();
}

// --------------------------- Client Ready Event ---------------------------
client.once("clientReady", async () => {
    logger.setClient(client);

    startStatusFiles(client, guildQueues);

    logger.info(`✅ Logged in as ${client.user.tag}`);
    logger.info(`📊 Connected to ${client.guilds.cache.size} guilds`);

    const rest = createCommandRest();
    const commandsJson = commandsToJson(commandBuilders);

    try {
        // Clear global commands to avoid duplicates
        await clearGlobalCommands(rest, client.application.id);
        logger.info("[COMMANDS] Cleared global commands");

        // Register guild-specific commands for immediate availability
        const guilds = client.guilds.cache;
        for (const [guildId] of guilds) {
            try {
                await putGuildCommands(rest, client.application.id, guildId, commandsJson);
                logger.info(`[COMMANDS] Registered for guild ${logger.guildTag(guildId)}`);
            } catch (guildErr) {
                logger.warn(`[COMMANDS] Failed for guild ${logger.guildTag(guildId)}: ${guildErr?.message}`);
            }
        }

        logger.info('='.repeat(60));
        logger.info('✨ Bot is ready!');
        logger.info('='.repeat(60));

        startHeartbeatLogger();
    } catch (err) {
        logger.error("[COMMANDS] Registration failed:", err);
    }
});

// --------------------------- Guild Join Event ---------------------------
client.on("guildCreate", async (guild) => {
    logger.info(`[GUILD JOIN] Joined: ${guild.name} (${guild.id})`);

    const rest = createCommandRest();
    const commandsJson = commandsToJson(commandBuilders);

    try {
        await putGuildCommands(rest, client.application.id, guild.id, commandsJson);
        logger.info(`[COMMANDS] Registered for new guild ${guild.id} (${guild.name})`);
    } catch (err) {
        logger.warn(`[COMMANDS] Failed for new guild ${guild.id} (${guild.name}): ${err?.message}`);
    }
});

// --------------------------- Auto-Leave when bot is alone in voice ---------------------------
client.on("voiceStateUpdate", (oldState, newState) => {
    // Only care about users leaving a voice channel
    if (!oldState.channel) return;

    const botMember = oldState.guild.members.me;
    if (!botMember?.voice?.channel) return;

    // Check if the bot's channel is the one someone left
    if (oldState.channel.id !== botMember.voice.channel.id) return;

    // Count non-bot members still in the channel
    const humanMembers = oldState.channel.members.filter(m => !m.user.bot).size;
    if (humanMembers === 0) {
        logger.info(`[AUTO-LEAVE][${oldState.guild.id} (${oldState.guild.name})] All users left voice channel, cleaning up`);
        deleteGuildQueue(oldState.guild.id);
    }
});

// --------------------------- Guild Leave Event ---------------------------
client.on("guildDelete", guild => {
    logger.info(`[GUILD LEAVE] Left: ${guild.name} (${guild.id})`);
    deleteGuildQueue(guild.id);
});

// --------------------------- Interaction Handler ---------------------------
client.on("interactionCreate", async interaction => {
    // --- Button interactions ---
    if (interaction.isButton()) {
        const customId = interaction.customId;
        if (customId.startsWith('play_single|') || customId.startsWith('play_playlist|')) {
            try {
                await handlePlaylistChoiceButton(createContext(interaction));
            } catch (err) {
                logger.error(`[BUTTON ERROR] ${err.message}`);
            }
        } else if (customId.startsWith('np_')) {
            try {
                await handleNowPlayingButton(createContext(interaction));
            } catch (err) {
                logger.error(`[NP BUTTON ERROR] ${err.message}`);
            }
        }
        return;
    }

    // --- Select menu interactions (search result picker) ---
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('search_pick|')) {
            try {
                await handleSearchSelect(createContext(interaction));
            } catch (err) {
                logger.error(`[SELECT MENU ERROR] ${err.message}`);
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const commandName = interaction.commandName;
    logger.debug(`[COMMAND] ${commandName} by ${interaction.user.tag} in guild ${interaction.guildId}`);

    const context = createContext(interaction);

    try {
        const handler = commandHandlers.get(commandName);
        if (handler) {
            await handler(context);
        } else {
            await interaction.reply({ content: "Unknown command", ephemeral: true });
        }
    } catch (error) {
        logger.error(`[COMMAND ERROR] ${commandName}:`, error);
        const errorMessage = "❌ Ein Fehler ist aufgetreten. Bitte versuche es erneut.";

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(() => { });
        } else {
            await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => { });
        }
    }
});

// --------------------------- Graceful Shutdown ---------------------------
installShutdownHandlers({ client, guildQueues, deleteGuildQueue, audioCache });

// --------------------------- Error Handlers ---------------------------
process.on("uncaughtException", err => {
    logger.error("[FATAL] Uncaught Exception:", err);
});

process.on("unhandledRejection", reason => {
    logger.error("[UNHANDLED REJECTION]", reason);
});

// --------------------------- Start Bot ---------------------------
if (require.main === module) {
    if (!TOKEN) {
        logger.error("❌ TOKEN environment variable not set. Exiting.");
        process.exit(1);
    }

    client.login(TOKEN).catch(err => {
        logger.error("❌ Login failed:", err);
        process.exit(1);
    });
}

// --------------------------- Exports for Testing ---------------------------
module.exports = {
    client,
    audioCache,
    searchCache,
    rateLimiter,
    backgroundDownloader,
    guildQueues
};
