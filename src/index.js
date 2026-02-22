// src/index.js
// Main entry point for Discord Musicbot
// Refactored architecture with modular components

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
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

// Initialize global instances
const audioCache = new AudioCache(undefined, DOWNLOAD_DIR);
const searchCache = new SearchCache();
const rateLimiter = new RateLimiter();
const backgroundDownloader = new BackgroundDownloader(audioCache, () => guildQueues);

// Log startup
logger.info('='.repeat(60));
logger.info('🎵 Discord Musicbot Starting...');
logger.info('='.repeat(60));

// Import command handlers from legacy file (temporary until full refactor)
// This allows us to keep existing command logic while refactoring core systems
const {
    handlePlayCommand,
    handleSelectCommand,
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
    handleRefreshCommand,
    handleClearcacheCommand,
    handleRepeatSingleCommand,
    handleRepeatCommand,
    handlePlaylistChoiceButton,
    handleNowPlayingButton
} = require('./commands/commandHandlers');

// --------------------------- Slash Command Definitions ---------------------------
const commandBuilders = [
    new SlashCommandBuilder()
        .setName("play")
        .setDescription("Spielt einen Song, Link oder Suchbegriff")
        .addStringOption(opt => opt.setName("query").setDescription("YouTube-Link oder Suchbegriff").setRequired(true)),

    new SlashCommandBuilder()
        .setName("select")
        .setDescription("Wähle ein Lied aus den Suchergebnissen")
        .addIntegerOption(option => option.setName("number").setDescription("Nummer des Liedes (1-10)").setRequired(true).setMinValue(1).setMaxValue(10)),

    new SlashCommandBuilder().setName("pause").setDescription("Pausiert die Wiedergabe"),
    new SlashCommandBuilder().setName("resume").setDescription("Setzt die Wiedergabe fort"),
    new SlashCommandBuilder().setName("skip").setDescription("Überspringt den aktuellen Song"),
    new SlashCommandBuilder().setName("stop").setDescription("Stoppt die Wiedergabe und leert die Queue"),
    new SlashCommandBuilder().setName("queue").setDescription("Zeigt die aktuelle Queue an"),
    new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Setzt die Lautstärke (0-100)")
        .addIntegerOption(opt => opt.setName("wert").setDescription("0-100").setRequired(true)),
    new SlashCommandBuilder().setName("leave").setDescription("Bot verlässt den Sprachkanal"),
    new SlashCommandBuilder().setName("shuffle").setDescription("Schaltet Shuffle ein/aus"),
    new SlashCommandBuilder().setName("test").setDescription("Spielt test.mp3 im Container"),
    new SlashCommandBuilder().setName("debug").setDescription("Debug-Informationen anzeigen"),
    new SlashCommandBuilder().setName("playcache").setDescription("Spielt alle Lieder aus dem Cache ab"),
    new SlashCommandBuilder().setName("refresh").setDescription("Commands neu registrieren (Admin only)"),
    new SlashCommandBuilder().setName("clearcache").setDescription("Cache leeren (Admin only)"),
    new SlashCommandBuilder().setName("repeatsingle").setDescription("Wiederholt den aktuellen Song"),
    new SlashCommandBuilder().setName("repeat").setDescription("Wiederholt die gesamte Queue")
];

// --------------------------- Discord Client Setup ---------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --------------------------- Client Ready Event ---------------------------
client.once("ready", async () => {
    logger.info(`✅ Logged in as ${client.user.tag}`);
    logger.info(`📊 Connected to ${client.guilds.cache.size} guilds`);

    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const commandsJson = commandBuilders.map(b => b.toJSON());

    try {
        // Clear global commands to avoid duplicates
        await rest.put(Routes.applicationCommands(client.application.id), { body: [] });
        logger.info("[COMMANDS] Cleared global commands");

        // Register guild-specific commands for immediate availability
        const guilds = client.guilds.cache;
        for (const [guildId] of guilds) {
            try {
                await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), { body: commandsJson });
                logger.info(`[COMMANDS] Registered for guild ${guildId}`);
            } catch (guildErr) {
                logger.warn(`[COMMANDS] Failed for guild ${guildId}: ${guildErr?.message}`);
            }
        }

        logger.info('='.repeat(60));
        logger.info('✨ Bot is ready!');
        logger.info('='.repeat(60));

        // --- Heartbeat Logger (Every 30s to diagnose lag) ---
        setInterval(() => {
            const memory = process.memoryUsage();
            const activeQueues = guildQueues.size;
            const bgStats = backgroundDownloader.getStats();

            logger.debug(`[HEARTBEAT] Memory: ${Math.round(memory.rss / 1024 / 1024)}MB RSS, ${Math.round(memory.heapUsed / 1024 / 1024)}MB Heap | Queues: ${activeQueues} | BG-Downloads: ${bgStats.isActive ? 'Active' : 'Idle'} (${bgStats.queueLength} pending)`);

            // Log specific guild states if active
            for (const [guildId, q] of guildQueues) {
                if (q.player.state.status === 'playing') {
                    const buffering = q.currentFfmpeg ? 'Buffering' : 'Ready';
                    logger.debug(`[STATUS][${guildId}] Playing: ${q.currentTrack?.title?.substring(0, 30)}... | State: ${buffering}`);
                }
            }
        }, 30000).unref();
    } catch (err) {
        logger.error("[COMMANDS] Registration failed:", err);
    }
});

// --------------------------- Guild Join Event ---------------------------
client.on("guildCreate", async (guild) => {
    logger.info(`[GUILD JOIN] Joined: ${guild.name} (${guild.id})`);

    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const commandsJson = commandBuilders.map(b => b.toJSON());

    try {
        await rest.put(Routes.applicationGuildCommands(client.application.id, guild.id), { body: commandsJson });
        logger.info(`[COMMANDS] Registered for new guild ${guild.id}`);
    } catch (err) {
        logger.warn(`[COMMANDS] Failed for new guild ${guild.id}: ${err?.message}`);
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
            const context = {
                interaction,
                audioCache,
                searchCache,
                rateLimiter,
                backgroundDownloader,
                guildQueues,
                createPlayerForGuild,
                createGuildQueue,
                deleteGuildQueue,
                logger
            };
            try {
                await handlePlaylistChoiceButton(context);
            } catch (err) {
                logger.error(`[BUTTON ERROR] ${err.message}`);
            }
        } else if (customId.startsWith('np_')) {
            const context = {
                interaction,
                audioCache,
                searchCache,
                rateLimiter,
                backgroundDownloader,
                guildQueues,
                createPlayerForGuild,
                createGuildQueue,
                deleteGuildQueue,
                logger
            };
            try {
                await handleNowPlayingButton(context);
            } catch (err) {
                logger.error(`[NP BUTTON ERROR] ${err.message}`);
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const commandName = interaction.commandName;
    logger.debug(`[COMMAND] ${commandName} by ${interaction.user.tag} in guild ${interaction.guildId}`);

    // Create context object for command handlers
    const context = {
        interaction,
        audioCache,
        searchCache,
        rateLimiter,
        backgroundDownloader,
        guildQueues,
        createPlayerForGuild,
        createGuildQueue,
        deleteGuildQueue,
        logger
    };

    try {
        // Route to appropriate command handler
        switch (commandName) {
            case 'play':
                await handlePlayCommand(context);
                break;
            case 'select':
                await handleSelectCommand(context);
                break;
            case 'pause':
                await handlePauseCommand(context);
                break;
            case 'resume':
                await handleResumeCommand(context);
                break;
            case 'skip':
                await handleSkipCommand(context);
                break;
            case 'stop':
                await handleStopCommand(context);
                break;
            case 'queue':
                await handleQueueCommand(context);
                break;
            case 'volume':
                await handleVolumeCommand(context);
                break;
            case 'leave':
                await handleLeaveCommand(context);
                break;
            case 'shuffle':
                await handleShuffleCommand(context);
                break;
            case 'test':
                await handleTestCommand(context);
                break;
            case 'debug':
                await handleDebugCommand(context);
                break;
            case 'playcache':
                await handlePlaycacheCommand(context);
                break;
            case 'refresh':
                await handleRefreshCommand(context);
                break;
            case 'clearcache':
                await handleClearcacheCommand(context);
                break;
            case 'repeatsingle':
                await handleRepeatSingleCommand(context);
                break;
            case 'repeat':
                await handleRepeatCommand(context);
                break;
            default:
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
function gracefulShutdown(signal) {
    logger.info(`[SHUTDOWN] Received ${signal}, cleaning up...`);

    // Destroy all voice connections
    for (const [guildId] of guildQueues) {
        try { deleteGuildQueue(guildId); } catch { }
    }

    // Force save cache
    try { audioCache.save(); } catch { }

    // Destroy client
    client.destroy();
    logger.info('[SHUTDOWN] Cleanup complete, exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
