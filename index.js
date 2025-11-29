// index.js
// Muse — Discord Music Bot (ohne DisTube)
// Features: async yt-dlp downloads, playlist support, lazy downloads, shuffle, now-playing embeds, progress updates, robust voice join

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionsBitField } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus } = require("@discordjs/voice");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

// --------------------------- Config ---------------------------
const TOKEN = process.env.TOKEN;
const YTDLP_BIN = process.env.YTDLP_PATH || "/opt/venv/bin/yt-dlp";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/muse_downloads";
const MAX_CACHE = parseInt(process.env.MAX_CACHE || "200", 10);
const DOWNLOAD_TIMEOUT_MS = (parseInt(process.env.DOWNLOAD_TIMEOUT_SEC || "120", 10)) * 1000; // default 2 min
const SEARCH_TIMEOUT_MS = (parseInt(process.env.SEARCH_TIMEOUT_SEC || "30", 10)) * 1000; // default 30 sec
const JOIN_RETRIES = 2; // retry join attempts on failure
const PROGRESS_EDIT_INTERVAL_MS = 2500; // how often we edit progress message

// --------------------------- Security & Validation ---------------------------
// Gefährliche URL-Patterns die blockiert werden sollen
const BLOCKED_URL_PATTERNS = [
    /localhost/i,
    /127\.0\.0\.1/,
    /192\.168\./,
    /10\./,
    /172\.(1[6-9]|2[0-9]|3[01])\./,
    /file:\/\//i,
    /ftp:\/\//i
];

const MAX_QUERY_LENGTH = 500;
const MAX_URL_LENGTH = 2048;

function sanitizeString(input) {
    if (typeof input !== 'string') return '';
    // Entferne potentiell gefährliche Zeichen
    return input.replace(/[<>"|&;$`\\]/g, '').trim();
}

// Prüft, ob eine Interaction noch gültig ist
function isInteractionValid(interaction) {
    const interactionAge = Date.now() - interaction.createdTimestamp;
    const maxAge = 15 * 60 * 1000; // 15 Minuten (Discord Limit)
    return interactionAge < maxAge;
}

// Hilfsfunktion für sichere Follow-Up Nachrichten mit Timeout-Prüfung
async function safeFollowUp(interaction, content, options = {}) {
    try {
        const interactionAge = Date.now() - interaction.createdTimestamp;
        const canFollowUp = interactionAge < 14 * 60 * 1000; // 14 Minuten
        
        if (!canFollowUp) {
            console.warn("[FOLLOWUP TIMEOUT] Interaction too old for follow-up");
            return null;
        }
        
        // Wenn deferred, verwende editReply für die erste Antwort
        if (interaction.deferred && !interaction.replied) {
            return await interaction.editReply(typeof content === 'string' ? { content, ...options } : content);
        }
        
        return await interaction.followUp(typeof content === 'string' ? { content, ...options } : content);
    } catch (error) {
        if (error.code === 10062) {
            console.warn("[FOLLOWUP EXPIRED] Interaction token expired");
        } else {
            console.error("[FOLLOWUP ERROR]", error);
        }
        return null;
    }
}

function validateUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') return false;
    if (urlString.length > MAX_URL_LENGTH) return false;
    
    try {
        const url = new URL(urlString);
        
        // Nur HTTP/HTTPS erlauben
        if (!['http:', 'https:'].includes(url.protocol)) return false;
        
        // Prüfe auf gefährliche URL-Patterns
        const fullUrl = urlString.toLowerCase();
        for (const pattern of BLOCKED_URL_PATTERNS) {
            if (pattern.test(fullUrl)) return false;
        }
        
        // Prüfe auf gefährliche Zeichen in der URL
        if (/[<>"|&;$`\\]/.test(urlString)) return false;
        
        return true;
    } catch {
        return false;
    }
}

function validateSearchQuery(query) {
    if (!query || typeof query !== 'string') return false;
    if (query.length > MAX_QUERY_LENGTH) return false;
    // Verhindere Command Injection Versuche
    const dangerousPatterns = [
        /[;&|`$(){}[\]]/,  // Shell metacharacters
        /\.\./,            // Directory traversal
        /^-/,              // Command flags
        /\x00/,            // Null bytes
        /[\r\n]/           // Line breaks
    ];
    return !dangerousPatterns.some(pattern => pattern.test(query));
}

// Allgemeine URL-Validierung für alle yt-dlp unterstützten Seiten
function isValidMediaUrl(urlString) {
    return validateUrl(urlString);
}

// YouTube-spezifische URL-Validierung (für YouTube-spezifische Funktionen)
function isValidYouTubeUrl(urlString) {
    if (!validateUrl(urlString)) return false;
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        
        // YouTube Video URL patterns
        if (hostname.includes('youtube.com')) {
            return url.searchParams.has('v') || url.pathname.includes('/watch');
        }
        if (hostname === 'youtu.be') {
            return url.pathname.length > 1;
        }
        return false;
    } catch {
        return false;
    }
}

// --------------------------- Utils ---------------------------
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function truncateMessage(msg, maxLen = 1950) { if (typeof msg !== "string") msg = String(msg); return msg.length > maxLen ? msg.substring(0, maxLen - 3) + "..." : msg; }
function isUrl(s) { return isValidMediaUrl(s); }
function isYouTubePlaylistUrl(u) { 
    try { 
        if (!validateUrl(u)) return false;
        const url = new URL(u); 
        return url.searchParams.has("list"); 
    } catch { 
        return false; 
    } 
}

// Extrahiert saubere YouTube URL ohne Parameter
function cleanYouTubeUrl(url) {
    if (!isValidYouTubeUrl(url)) return null;
    
    try {
        const urlObj = new URL(url);
        
        // Für youtu.be Links
        if (urlObj.hostname === 'youtu.be') {
            const videoId = urlObj.pathname.substring(1);
            if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        // Für youtube.com Links
        if (urlObj.hostname.includes('youtube.com')) {
            const videoId = urlObj.searchParams.get('v');
            if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        return null;
    } catch {
        return null;
    }
}
function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return "unbekannt";
    seconds = Math.floor(Number(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
}

function shuffleArray(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// --------------------------- Cache ---------------------------
class AudioCache {
    constructor(maxEntries = MAX_CACHE) {
        this.maxEntries = maxEntries;
        this.indexFile = path.join(DOWNLOAD_DIR, ".cache_index.json");
        this.cache = new Map(); // key -> { filepath, filename, ts, meta }
        ensureDir(DOWNLOAD_DIR);
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.indexFile)) {
                const raw = fs.readFileSync(this.indexFile, "utf-8");
                const arr = JSON.parse(raw);
                this.cache = new Map(arr);
                console.log(`[CACHE] loaded ${this.cache.size} entries`);
            }
        } catch (e) {
            console.warn("[CACHE] load failed:", e.message);
            this.cache = new Map();
        }
    }

    save() {
        try {
            fs.writeFileSync(this.indexFile, JSON.stringify([...this.cache]), "utf-8");
        } catch (e) {
            console.error("[CACHE] save failed:", e.message);
        }
    }

    makeKeyFromUrl(url) {
        try {
            const u = new URL(url);
            if (u.hostname.includes("youtu")) {
                if (u.searchParams.has("v")) return u.searchParams.get("v");
                const p = u.pathname.split("/").filter(Boolean);
                if (u.hostname.includes("youtu.be") && p.length) return p[p.length - 1];
            }
        } catch {}
        return url;
    }

    has(url) {
        const key = this.makeKeyFromUrl(url);
        const e = this.cache.get(key);
        if (!e) return false;
        if (!fs.existsSync(e.filepath)) { this.cache.delete(key); this.save(); return false; }
        return true;
    }

    get(url) {
        const key = this.makeKeyFromUrl(url);
        return this.cache.get(key)?.filepath || null;
    }

    set(url, filepath, meta = {}) {
        const key = this.makeKeyFromUrl(url);
        this.cache.set(key, { filepath, filename: path.basename(filepath), ts: Date.now(), meta });
        // trim LRU-ish
        if (this.cache.size > this.maxEntries) {
            const sorted = [...this.cache.entries()].sort((a,b)=>a[1].ts - b[1].ts);
            const toRemove = Math.ceil(this.maxEntries * 0.2);
            for (let i = 0; i < toRemove; i++) {
                const [k,v] = sorted[i];
                try { if (fs.existsSync(v.filepath)) fs.unlinkSync(v.filepath); } catch {}
                this.cache.delete(k);
            }
        }
        this.save();
    }
}
const audioCache = new AudioCache(MAX_CACHE);

// --------------------------- Rate Limiting ---------------------------
const downloadLimiter = new Map(); // userId -> { count, resetTime }
const MAX_DOWNLOADS_PER_USER = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 Minute

// --------------------------- Search Cache ---------------------------
const searchCache = new Map(); // userId -> { results: [], timestamp }
const SEARCH_CACHE_TIMEOUT = 5 * 60 * 1000; // 5 Minuten

function checkRateLimit(userId) {
    const now = Date.now();
    const userLimit = downloadLimiter.get(userId);
    
    if (!userLimit || now > userLimit.resetTime) {
        downloadLimiter.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }
    
    if (userLimit.count >= MAX_DOWNLOADS_PER_USER) {
        return false;
    }
    
    userLimit.count++;
    return true;
}

// --------------------------- Guild Queue System ---------------------------
// guildQueues: Map<guildId, { connection, player, songs: [track], volume, shuffle, lastInteractionChannel }>
const guildQueues = new Map();

function createPlayerForGuild(gid, connection) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on("error", err => console.error(`[PLAYER ERROR][${gid}]`, err?.message || err));
    player.on(AudioPlayerStatus.Idle, () => {
        // Lösche die "Now Playing" Nachricht wenn Song fertig ist
        const queue = guildQueues.get(gid);
        if (queue && queue.nowPlayingMessage) {
            queue.nowPlayingMessage.delete().catch(() => {
                // Ignoriere Fehler beim Löschen (z.B. Nachricht bereits gelöscht)
            });
            queue.nowPlayingMessage = null;
        }
        
        // ensure next track is downloaded and played (this handles lazy downloads)
        ensureNextTrackDownloadedAndPlay(gid).catch(e => console.error("[ENSURE NEXT ERROR]", e?.message || e));
    });
    return player;
}

// --------------------------- yt-dlp helpers ---------------------------
function spawnYtdlp(args, opts = {}) {
    return new Promise((resolve, reject) => {
        // Validiere alle Argumente
        const safeArgs = args.filter(arg => {
            if (typeof arg !== 'string') return false;
            // Verhindere gefährliche Flags
            if (arg.startsWith('--exec') || arg.startsWith('--command')) return false;
            if (arg.includes('..') || arg.includes('\x00')) return false;
            return true;
        });

        const proc = spawn(YTDLP_BIN, safeArgs, { 
            ...opts, 
            stdio: ["ignore","pipe","pipe"],
            shell: false // Verhindere Shell-Injection
        });
        let stdout = "", stderr = "";
        proc.stdout.on("data", d => { stdout += d.toString(); });
        proc.stderr.on("data", d => { stderr += d.toString(); });
        const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("yt-dlp timeout")); }, DOWNLOAD_TIMEOUT_MS);
        proc.on("error", err => { clearTimeout(timer); reject(err); });
        proc.on("close", code => { clearTimeout(timer); if (code === 0) resolve({ stdout, stderr, code }); else reject(new Error(`yt-dlp exited ${code}: ${stderr.split("\n").slice(-6).join("\n")}`)); });
    });
}

// Spezielle Funktion für Suchoperationen mit kürzerem Timeout
function spawnYtdlpSearch(args, opts = {}) {
    return new Promise((resolve, reject) => {
        // Validiere alle Argumente
        const safeArgs = args.filter(arg => {
            if (typeof arg !== 'string') return false;
            // Verhindere gefährliche Flags
            if (arg.startsWith('--exec') || arg.startsWith('--command')) return false;
            if (arg.includes('..') || arg.includes('\x00')) return false;
            return true;
        });

        const proc = spawn(YTDLP_BIN, safeArgs, { 
            ...opts, 
            stdio: ["ignore","pipe","pipe"],
            shell: false // Verhindere Shell-Injection
        });
        let stdout = "", stderr = "";
        proc.stdout.on("data", d => { stdout += d.toString(); });
        proc.stderr.on("data", d => { stderr += d.toString(); });
        const timer = setTimeout(() => { 
            proc.kill("SIGKILL"); 
            reject(new Error("Search timeout - try a more specific query")); 
        }, SEARCH_TIMEOUT_MS);
        proc.on("error", err => { clearTimeout(timer); reject(err); });
        proc.on("close", code => { 
            clearTimeout(timer); 
            if (code === 0) resolve({ stdout, stderr, code }); 
            else reject(new Error(`Search failed: ${stderr.split("\n").slice(-3).join("\n")}`)); 
        });
    });
}

// Get info JSON for url or search query. Accepts "ytsearch1:..." style query too.
async function getYtdlpInfo(urlOrQuery) {
    // Validiere Input
    if (typeof urlOrQuery !== 'string') {
        throw new Error('Invalid input: must be string');
    }
    
    // Für URLs: strenge Validierung
    if (urlOrQuery.startsWith('http')) {
        if (!isValidMediaUrl(urlOrQuery)) {
            throw new Error('Invalid or unsafe URL');
        }
    } 
    // Für Suchanfragen: ytsearch1: prefix validieren
    else if (urlOrQuery.startsWith('ytsearch1:')) {
        const query = urlOrQuery.substring(10);
        if (!validateSearchQuery(query)) {
            throw new Error('Invalid search query');
        }
    } 
    else {
        throw new Error('Input must be valid URL or ytsearch1: query');
    }

    // use -J to get JSON
    const args = ["-J", "--no-warnings", "--socket-timeout", "60", urlOrQuery];
    const { stdout } = await spawnYtdlp(args);
    return JSON.parse(stdout);
}

// get playlist entries (full info so we can get durations and thumbnails)
async function getPlaylistEntries(playlistUrl) {
    // Validiere Playlist URL
    if (!isYouTubePlaylistUrl(playlistUrl)) {
        throw new Error('Invalid playlist URL');
    }

    // -J liefert JSON; --ignore-errors ignoriert gesperrte Videos
    const args = [
        "-J",
        "--no-warnings",
        "--socket-timeout", "60",
        "--ignore-errors",
        "--extractor-args", "youtube:player_client=default",
        playlistUrl
    ];
    const { stdout } = await spawnYtdlp(args);
    const json = JSON.parse(stdout);
    const playlistTitle = sanitizeString(json.title || json.playlist_title || "Playlist");
    const entriesRaw = json.entries || [];

    // filter: nur gültige URLs und sichere Daten
    const entries = entriesRaw
        .filter(e => e.webpage_url && isValidMediaUrl(e.webpage_url))
        .slice(0, 100) // Begrenze Playlist-Größe
        .map(e => ({
            url: e.webpage_url,
            title: sanitizeString(e.title || e.id || "Unbekannt"),
            duration: e.duration || null,
            thumbnail: (e.thumbnails && e.thumbnails.length) ? e.thumbnails[e.thumbnails.length-1].url : null
        }));

    return { playlistTitle, entries };
}

// download single video to filepath using yt-dlp (reports stderr progress lines)
// progressCb receives an object { percent, downloaded, eta, speed, raw } when parsed
function downloadSingleTo(filepath, urlOrId, progressCb) {
    return new Promise((resolve, reject) => {
        // Validiere URL
        if (!isValidMediaUrl(urlOrId)) {
            return reject(new Error('Invalid or unsafe URL for download'));
        }

        // Validiere Filepath
        if (!filepath || typeof filepath !== 'string') {
            return reject(new Error('Invalid filepath'));
        }

        // Stelle sicher, dass filepath im erlaubten Verzeichnis ist
        const normalizedPath = path.normalize(filepath);
        const normalizedDownloadDir = path.normalize(DOWNLOAD_DIR);
        if (!normalizedPath.startsWith(normalizedDownloadDir)) {
            return reject(new Error('Filepath outside allowed directory'));
        }

        ensureDir(DOWNLOAD_DIR);
        const args = [
            "-f", "bestaudio",
            "--extract-audio",
            "--audio-format", "m4a",
            "--audio-quality", "320K",
            "--socket-timeout", "60",
            "--retries", "3",
            "--no-warnings",
            "--no-playlist",
            "-o", filepath,
            urlOrId
        ];
        const proc = spawn(YTDLP_BIN, args, { shell: false });
        let stderr = "";
        let lastProgress = null;

        proc.stderr.on("data", d => {
            const str = d.toString();
            stderr += str;
            // parse percent pattern from yt-dlp/yt-dlp stderr lines like:
            // [download]  12.3% of 3.45MiB at 123.45KiB/s ETA 00:12
            const m = str.match(/(\d{1,3}\.\d+)% of .* at ([\d\.]+\w+\/s) ETA (\d{2}:\d{2}(:\d{2})?)/);
            const m2 = str.match(/(\d{1,3}\.\d+)%/);
            if (m) {
                const percent = parseFloat(m[1]);
                const speed = m[2];
                const eta = m[3];
                lastProgress = { percent, speed, eta, raw: str };
                if (progressCb) progressCb(lastProgress);
            } else if (m2) {
                lastProgress = { percent: parseFloat(m2[1]), raw: str };
                if (progressCb) progressCb(lastProgress);
            } else {
                // forward raw lines occasionally
                if (progressCb) progressCb({ raw: str });
            }
        });

        const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Download timeout")); }, DOWNLOAD_TIMEOUT_MS);

        proc.on("error", err => { clearTimeout(timer); reject(err); });
        proc.on("close", code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(filepath)) resolve({ filepath, stderr });
            else reject(new Error(`yt-dlp failed (${code}): ${stderr.split("\n").slice(-6).join("\n")}`));
        });
    });
}

async function getVideoInfo(urlOrId) {
    // Validiere URL
    if (!isValidMediaUrl(urlOrId)) {
        throw new Error('Invalid or unsafe URL');
    }

    const args = ["-J", "--no-warnings", urlOrId];
    console.log(`[VIDEO INFO] Getting info for: ${urlOrId}`);
    const start = Date.now();
    
    try {
        const { stdout } = await spawnYtdlpSearch(args); // Verwende kurzes Timeout für Info-Abfrage
        const elapsed = Date.now() - start;
        console.log(`[VIDEO INFO] Success in ${elapsed}ms`);
        
        const info = JSON.parse(stdout);
        return {
            title: sanitizeString(info.title || "Unbekannt"),
            duration: info.duration ? formatDuration(info.duration) : "unbekannt",
            url: info.webpage_url || info.url
        };
    } catch (err) {
        const elapsed = Date.now() - start;
        console.error(`[VIDEO INFO] Failed after ${elapsed}ms:`, err.message);
        throw err;
    }
}

// Suche nach YouTube Videos (bis zu 10 Ergebnisse)
// Allgemeine Suche für alle yt-dlp unterstützten Plattformen
async function searchVideos(query, maxResults = 10, platform = 'youtube') {
    if (!validateSearchQuery(query)) {
        throw new Error('Invalid search query');
    }

    let searchQuery;
    switch (platform.toLowerCase()) {
        case 'youtube':
            searchQuery = `ytsearch${maxResults}:${query}`;
            break;
        case 'soundcloud':
            searchQuery = `scsearch${maxResults}:${query}`;
            break;
        default:
            // Allgemeine Suche (primär YouTube)
            searchQuery = `ytsearch${maxResults}:${query}`;
    }

    const args = [
        "-J", 
        "--no-warnings", 
        "--flat-playlist",
        searchQuery
    ];
    
    const { stdout } = await spawnYtdlpSearch(args);
    const info = JSON.parse(stdout);
    
    if (!info.entries || !Array.isArray(info.entries)) {
        return [];
    }
    
    return info.entries
        .filter(entry => entry.url && entry.title)
        .slice(0, maxResults)
        .map((entry, index) => ({
            index: index + 1,
            id: entry.id || entry.url,
            title: sanitizeString(entry.title),
            duration: entry.duration ? formatDuration(entry.duration) : "unbekannt",
            url: entry.url,
            uploader: sanitizeString(entry.uploader || entry.channel || "Unbekannt"),
            platform: platform
        }));
}

// YouTube-spezifische Suchfunktion (für Backward Compatibility)
async function searchYouTubeVideos(query, maxResults = 10) {
    const results = await searchVideos(query, maxResults, 'youtube');
    // Konvertiere zu YouTube-spezifischem Format
    return results.map(result => ({
        ...result,
        url: result.id ? `https://www.youtube.com/watch?v=${result.id}` : result.url
    }));
}

// --------------------------- Commands ---------------------------
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
    new SlashCommandBuilder().setName("refresh").setDescription("Commands neu registrieren (Admin only)")
];

// --------------------------- Client & Command registration ---------------------------
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const commandsJson = commandBuilders.map(b => b.toJSON());
    
    try {
        // Lösche zuerst alle globalen Commands um Duplikate zu vermeiden
        await rest.put(Routes.applicationCommands(client.application.id), { body: [] });
        console.log("[COMMANDS] Cleared global commands to avoid duplicates");
        
        // Registriere nur guild-spezifische Commands für sofortige Verfügbarkeit ohne Duplikate
        const guilds = client.guilds.cache;
        for (const [guildId] of guilds) {
            try {
                await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), { body: commandsJson });
                console.log(`[COMMANDS] Registered commands for guild ${guildId}`);
            } catch (guildErr) {
                console.warn(`[COMMANDS] Failed to register for guild ${guildId}:`, guildErr?.message);
            }
        }
    } catch (err) {
        console.error("[COMMANDS] Register failed:", err?.message || err);
    }
});

// Registriere Commands wenn Bot zu neuem Server hinzugefügt wird
client.on("guildCreate", async (guild) => {
    console.log(`[GUILD JOIN] Joined guild: ${guild.name} (${guild.id})`);
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const commandsJson = commandBuilders.map(b => b.toJSON());
    
    try {
        await rest.put(Routes.applicationGuildCommands(client.application.id, guild.id), { body: commandsJson });
        console.log(`[COMMANDS] Registered commands for new guild ${guild.id}`);
    } catch (err) {
        console.warn(`[COMMANDS] Failed to register for new guild ${guild.id}:`, err?.message);
    }
});

// --------------------------- Interaction Handler ---------------------------
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const guildId = interaction.guildId;
    const memberVoice = interaction.member?.voice?.channel;
    let queue = guildQueues.get(guildId);

    try {
        switch (interaction.commandName) {
            case "play": {
                // Prüfe, ob Interaction noch gültig ist
                if (!isInteractionValid(interaction)) {
                    console.log("[INTERACTION EXPIRED] Play command received but interaction is too old");
                    return; // Beende die Verarbeitung stillschweigend
                }
                
                if (!memberVoice) return interaction.reply({ content: "Du musst in einem Sprachkanal sein!", ephemeral: true });
                
                const rawQuery = interaction.options.getString("query", true);
                
                // Rate-Limiting prüfen
                if (!checkRateLimit(interaction.user.id)) {
                    return interaction.reply({ 
                        content: "⚠️ Du hast zu viele Downloads angefragt. Warte eine Minute und versuche es erneut.", 
                        ephemeral: true 
                    });
                }
                
                // Input-Validierung
                if (!rawQuery || typeof rawQuery !== 'string') {
                    return interaction.reply({ content: "❌ Ungültige Eingabe.", ephemeral: true });
                }
                
                const sanitizedQuery = sanitizeString(rawQuery);
                if (!sanitizedQuery) {
                    return interaction.reply({ content: "❌ Eingabe enthält ungültige Zeichen.", ephemeral: true });
                }
                
                // Längen-Validierung
                if (sanitizedQuery.length > MAX_QUERY_LENGTH) {
                    return interaction.reply({ content: `❌ Eingabe zu lang (max. ${MAX_QUERY_LENGTH} Zeichen).`, ephemeral: true });
                }
                
                // Defer reply für längere Operationen - mit Timeout-Prüfung
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.deferReply();
                    }
                } catch (err) {
                    console.error("[DEFER ERROR]", err.message);
                    if (err.code === 10062) {
                        console.log("[INTERACTION EXPIRED] Cannot defer - interaction token expired");
                        return; // Beende die Verarbeitung, da Interaction abgelaufen ist
                    }
                    throw err; // Andere Fehler weiterwerfen
                }
                
                const replyMsg = await safeFollowUp(interaction, `🔎 Verarbeite: ${truncateMessage(sanitizedQuery, 100)}`);

                // Ensure queue exists or create when needed
                async function ensureQueueAndJoin() {
                    if (!queue) {
                        // robust join: try a few times
                        let conn;
                        let lastErr;
                        for (let attempt = 0; attempt <= JOIN_RETRIES; attempt++) {
                            try {
                                conn = joinVoiceChannel({
                                    channelId: memberVoice.id,
                                    guildId,
                                    adapterCreator: memberVoice.guild.voiceAdapterCreator
                                });
                                // create player and subscribe
                                const player = createPlayerForGuild(guildId, conn);
                                conn.subscribe(player);
                                queue = { connection: conn, player, songs: [], volume: 50, shuffle: false, lastInteractionChannel: interaction.channel };
                                guildQueues.set(guildId, queue);
                                return queue;
                            } catch (e) {
                                lastErr = e;
                                console.warn(`[JOIN] Attempt ${attempt} failed:`, e?.message || e);
                                // small delay before retry
                                await new Promise(r => setTimeout(r, 700));
                            }
                        }
                        throw lastErr || new Error("Failed to join voice channel");
                    } else {
                        queue.lastInteractionChannel = interaction.channel;
                        return queue;
                    }
                }

                // Playlist handling
                if (isYouTubePlaylistUrl(sanitizedQuery)) {
                    await ensureQueueAndJoin();

                    let playlistInfo;
                    try {
                        playlistInfo = await getPlaylistEntries(sanitizedQuery);
                    } catch (e) {
                        // yt-dlp Fehler mit einzelnen Videos ignorieren, falls möglich
                        console.warn("[PLAYLIST READ ERROR]", e.message);
                        return await safeFollowUp(interaction, `⚠️ Playlist konnte nicht vollständig geladen werden: ${e.message}`);
                    }

                    let { playlistTitle, entries } = playlistInfo;
                    if (!entries || !entries.length) return await safeFollowUp(interaction, "Keine Einträge gefunden.");

                    // Filter: entferne bereits eindeutig fehlerhafte Videos (z.B. keine URL)
                    entries = entries.filter(e => e.url);

                    if (!entries.length) return await safeFollowUp(interaction, "Keine gültigen Einträge in der Playlist gefunden.");

                    // erstes Lied sofort abspielen
                    const [firstEntry, ...restEntries] = entries;

                    // restliche Tracks lazy in Queue hinzufügen
                    for (const e of restEntries) {
                        queue.songs.push({
                            requesterId: interaction.user.id,
                            title: e.title || "Unbekannt",
                            filepath: null,
                            url: e.url,
                            duration: e.duration || null,
                            thumbnail: e.thumbnail || null,
                            playlistTitle
                        });
                    }

                    // Funktion für sicheres Abspielen einzelner Tracks
                    async function safePlay(entry) {
                        try {
                            await handleSingleUrlPlay(interaction, entry.url);
                        } catch (err) {
                            console.warn(`[PLAYLIST TRACK ERROR] ${entry.title}: ${err.message}`);
                            // Wenn noch Rest vorhanden -> nächsten Track versuchen
                            if (restEntries.length > 0) {
                                const nextEntry = restEntries.shift();
                                await safeFollowUp(interaction, `⚠️ Fehler bei Track "${entry.title}", überspringe zu "${nextEntry.title}"`);
                                await safePlay(nextEntry);
                            } else {
                                await safeFollowUp(interaction, "⚠️ Alle Tracks der Playlist fehlerhaft oder nicht verfügbar.");
                            }
                        }
                    }

                    // starte erstes Lied
                    await safePlay(firstEntry);

                    await safeFollowUp(interaction, `➕ Playlist **${playlistTitle}** (${entries.length} Einträge) zur Queue hinzugefügt.`);
                    return;
                }


                // If not URL => treat as search
                if (!isUrl(sanitizedQuery)) {
                    // Zusätzliche Validierung für Suchanfragen
                    if (!validateSearchQuery(sanitizedQuery)) {
                        return await safeFollowUp(interaction, "❌ Ungültige Suchanfrage. Verwende nur alphanumerische Zeichen und Leerzeichen.");
                    }
                    
                    await safeFollowUp(interaction, "🔍 Suche nach Videos...");
                    console.log(`[SEARCH START] Query: "${sanitizedQuery}"`);
                    
                    let searchResults;
                    try {
                        const searchStart = Date.now();
                        searchResults = await searchYouTubeVideos(sanitizedQuery, 10);
                        const searchTime = Date.now() - searchStart;
                        console.log(`[SEARCH SUCCESS] Found ${searchResults.length} results in ${searchTime}ms`);
                    } catch (e) {
                        console.error("[YOUTUBE SEARCH ERROR]", e?.message || e);
                        const errorMsg = e.message.includes('timeout') 
                            ? "❌ Suche dauerte zu lange. Versuche einen spezifischeren Suchbegriff."
                            : `❌ Suche fehlgeschlagen: ${e.message}`;
                        return await safeFollowUp(interaction, errorMsg);
                    }

                    if (!searchResults || searchResults.length === 0) {
                        return await safeFollowUp(interaction, "❌ Keine Ergebnisse gefunden.");
                    }

                    // Cache die Suchergebnisse für den Benutzer
                    searchCache.set(interaction.user.id, {
                        results: searchResults,
                        timestamp: Date.now()
                    });

                    // Erstelle die Ergebnisliste
                    let resultText = "🎵 **Suchergebnisse:**\n\n";
                    searchResults.forEach(result => {
                        resultText += `**${result.index}.** ${result.title}\n`;
                        resultText += `   👤 ${result.uploader} | ⏱️ ${result.duration}\n\n`;
                    });
                    
                    resultText += "💡 Verwende `/select <nummer>` um ein Lied auszuwählen (z.B. `/select 1`)";

                    return await safeFollowUp(interaction, truncateMessage(resultText, 1900));
                }

                // direct url - bereinige URL von Parametern
                const cleanUrl = cleanYouTubeUrl(sanitizedQuery);
                if (!cleanUrl) {
                    return await safeFollowUp(interaction, "❌ Ungültige YouTube URL.");
                }
                
                return await handleSingleUrlPlay(interaction, cleanUrl, replyMsg);
            }

            case "select": {
                // Prüfe, ob Interaction noch gültig ist
                if (!isInteractionValid(interaction)) {
                    console.log("[INTERACTION EXPIRED] Select command received but interaction is too old");
                    return; // Beende die Verarbeitung stillschweigend
                }
                
                const number = interaction.options.getInteger("number");
                const userId = interaction.user.id;
                
                // Prüfe ob Suchergebnisse im Cache vorhanden sind
                const cached = searchCache.get(userId);
                if (!cached) {
                    return interaction.reply("❌ Keine Suchergebnisse gefunden. Verwende zuerst `/play <suchbegriff>`.");
                }
                
                // Prüfe ob Cache noch gültig ist
                if (Date.now() - cached.timestamp > SEARCH_CACHE_TIMEOUT) {
                    searchCache.delete(userId);
                    return interaction.reply("❌ Suchergebnisse sind abgelaufen. Verwende `/play <suchbegriff>` für eine neue Suche.");
                }
                
                // Prüfe ob die Nummer gültig ist
                if (number < 1 || number > cached.results.length) {
                    return interaction.reply(`❌ Ungültige Nummer. Wähle zwischen 1 und ${cached.results.length}.`);
                }
                
                const selectedResult = cached.results[number - 1];
                
                // Lösche Cache nach Auswahl
                searchCache.delete(userId);
                
                // Defer reply für längere Operationen - mit Timeout-Prüfung
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.deferReply();
                    }
                } catch (err) {
                    console.error("[DEFER ERROR]", err.message);
                    if (err.code === 10062) {
                        console.log("[INTERACTION EXPIRED] Cannot defer - interaction token expired");
                        return; // Beende die Verarbeitung, da Interaction abgelaufen ist
                    }
                    throw err; // Andere Fehler weiterwerfen
                }
                
                const replyMsg = await safeFollowUp(interaction, `🎵 Spiele: **${selectedResult.title}**`);
                
                return await handleSingleUrlPlay(interaction, selectedResult.url, replyMsg);
            }

            case "pause": {
                if (!queue) return interaction.reply("Keine Musik läuft.");
                queue.player.pause();
                return interaction.reply("⏸️ Pausiert.");
            }

            case "resume": {
                if (!queue) return interaction.reply("Keine Musik läuft.");
                queue.player.unpause();
                return interaction.reply("▶️ Fortgesetzt.");
            }

            case "skip": {
                if (!queue) return interaction.reply("Keine Musik läuft.");
                
                // Lösche "Now Playing" Nachricht (wird auch automatisch durch Idle Event gelöscht)
                if (queue.nowPlayingMessage) {
                    queue.nowPlayingMessage.delete().catch(() => {});
                    queue.nowPlayingMessage = null;
                }
                
                queue.player.stop(); // triggers Idle -> next track
                return interaction.reply("⏭️ Übersprungen.");
            }

            case "stop": {
                if (!queue) return interaction.reply("Keine Musik läuft.");
                
                // Lösche "Now Playing" Nachricht
                if (queue.nowPlayingMessage) {
                    queue.nowPlayingMessage.delete().catch(() => {});
                }
                
                queue.player.stop();
                try { queue.connection.destroy(); } catch {}
                guildQueues.delete(guildId);
                return interaction.reply("🛑 Gestoppt & Queue gelöscht.");
            }

            case "queue": {
                if (!queue || queue.songs.length === 0) return interaction.reply("Queue ist leer.");
                const lines = queue.songs.slice(0, 15).map((s,i) => `**${i+1}.** ${s.title || s.url || "Unbekannt"} ${s.duration ? `(${formatDuration(s.duration)})` : ""}${s.playlistTitle ? ` — ${s.playlistTitle}` : ""}`);
                return interaction.reply({ content: `🎶 Queue:\n${lines.join("\n")}` });
            }

            case "volume": {
                const val = Math.max(0, Math.min(100, interaction.options.getInteger("wert", true)));
                if (!queue) return interaction.reply("Keine Musik läuft.");
                queue.volume = val;
                try {
                    const res = queue.player.state.resource;
                    if (res && res.volume) res.volume.setVolume(val / 100);
                } catch {}
                return interaction.reply(`🔊 Lautstärke: ${val}%`);
            }

            case "leave": {
                if (!queue) return interaction.reply("Ich bin in keinem Sprachkanal.");
                queue.player.stop();
                try { queue.connection.destroy(); } catch {}
                guildQueues.delete(guildId);
                return interaction.reply("👋 Verlasse Sprachkanal.");
            }

            case "shuffle": {
                // toggle shuffle
                if (!queue) {
                    // create lightweight queue state to store shuffle preference
                    queue = { connection: null, player: null, songs: [], volume: 50, shuffle: true, lastInteractionChannel: interaction.channel };
                    guildQueues.set(guildId, queue);
                    return interaction.reply("🔀 Shuffle aktiviert (keine Queue aktiv; erstelle Verbindung durch /play).");
                } else {
                    queue.shuffle = !queue.shuffle;
                    return interaction.reply(`🔀 Shuffle ${queue.shuffle ? "aktiviert" : "deaktiviert"}.`);
                }
            }

            case "test": {
                if (!memberVoice) return interaction.reply("Du musst in einem Sprachkanal sein!");
                if (!fs.existsSync("/app/test.mp3")) return interaction.reply("test.mp3 fehlt im Container (/app/test.mp3)");
                const conn = joinVoiceChannel({ channelId: memberVoice.id, guildId, adapterCreator: memberVoice.guild.voiceAdapterCreator });
                const player = createPlayerForGuild(guildId, conn);
                conn.subscribe(player);
                const res = createAudioResource("/app/test.mp3");
                player.play(res);
                return interaction.reply("🎧 Test-Audio wird abgespielt!");
            }

            case "debug": {
                const embed = new EmbedBuilder()
                    .setTitle("🔧 Debug-Informationen")
                    .setColor(0x00ff00)
                    .addFields(
                        { name: "Bot Status", value: "✅ Online", inline: true },
                        { name: "Guild ID", value: guildId || "Unbekannt", inline: true },
                        { name: "Commands", value: commandBuilders.map(c => `/${c.name}`).join(", "), inline: false },
                        { name: "Voice Channel", value: memberVoice ? `${memberVoice.name} (${memberVoice.id})` : "Nicht verbunden", inline: false },
                        { name: "Queue Status", value: queue ? `${queue.songs.length} Songs` : "Keine Queue", inline: true },
                        { name: "Bot Version", value: "Enhanced Search & URL Parsing", inline: true }
                    )
                    .setTimestamp();
                
                return interaction.reply({ embeds: [embed] });
            }

            case "refresh": {
                // Prüfe Admin-Berechtigung
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply("❌ Nur Administratoren können Commands neu registrieren.");
                }

                await interaction.deferReply();
                
                try {
                    const rest = new REST({ version: "10" }).setToken(TOKEN);
                    const commandsJson = commandBuilders.map(b => b.toJSON());
                    
                    // Lösche globale Commands
                    await rest.put(Routes.applicationCommands(client.application.id), { body: [] });
                    
                    // Registriere guild-spezifische Commands
                    await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), { body: commandsJson });
                    
                    return interaction.editReply("✅ Commands erfolgreich neu registriert! Duplikate entfernt.");
                } catch (err) {
                    console.error("[REFRESH ERROR]", err);
                    return interaction.editReply("❌ Fehler beim Registrieren der Commands.");
                }
            }

            default:
                return interaction.reply("Unbekannter Befehl.");
        }
    } catch (err) {
        console.error("[INTERACTION ERROR]", err);
        
        // Sichere Error-Behandlung
        const errorMessage = err && err.message ? err.message : 'Unbekannter Fehler';
        const safeErrorMessage = sanitizeString(errorMessage);
        
        try {
            // Prüfe ob Interaction noch gültig ist (nicht älter als 2.5 Sekunden für reply)
            const interactionAge = Date.now() - interaction.createdTimestamp;
            const canReply = !interaction.replied && !interaction.deferred && interactionAge < 2500;
            const canFollowUp = (interaction.replied || interaction.deferred) && interactionAge < 14 * 60 * 1000; // 14 Minuten
            
            if (canReply) {
                await interaction.reply({ 
                    content: truncateMessage(`❌ Fehler: ${safeErrorMessage}`), 
                    ephemeral: true 
                });
            } else if (canFollowUp) {
                await interaction.followUp({ 
                    content: truncateMessage(`❌ Fehler: ${safeErrorMessage}`), 
                    ephemeral: true 
                });
            } else {
                console.warn("[INTERACTION TIMEOUT] Cannot respond to interaction - too old or already handled");
            }
        } catch (replyError) {
            // Prüfe ob es ein "Unknown interaction" Fehler ist
            if (replyError.code === 10062) {
                console.warn("[INTERACTION EXPIRED] Interaction token expired, cannot respond");
            } else {
                console.error("[ERROR REPLY FAILED]", replyError);
            }
        }
        
        // Bei kritischen Fehlern: Queue cleanup
        if (err.message && err.message.includes('voice') || err.message.includes('connection')) {
            try {
                const queue = guildQueues.get(guildId);
                if (queue) {
                    queue.player.stop();
                    queue.connection.destroy();
                    guildQueues.delete(guildId);
                }
            } catch (cleanupError) {
                console.error("[CLEANUP ERROR]", cleanupError);
            }
        }
    }
});

// --------------------------- Handle single URL play (downloads lazily, progress edits) ---------------------------
async function handleSingleUrlPlay(interaction, url) {
    // Validiere URL
    if (!isValidMediaUrl(url)) {
        throw new Error('Ungültige oder unsichere URL');
    }

    const guildId = interaction.guildId;
    const memberVoice = interaction.member.voice.channel;
    
    if (!memberVoice) {
        throw new Error('Du musst in einem Sprachkanal sein');
    }
    
    let queue = guildQueues.get(guildId);

    // Ensure queue exists
    if (!queue) {
        const conn = joinVoiceChannel({
            channelId: memberVoice.id,
            guildId,
            adapterCreator: memberVoice.guild.voiceAdapterCreator
        });
        const player = createPlayerForGuild(guildId, conn);
        conn.subscribe(player);
        queue = { connection: conn, player, songs: [], volume: 50, lastInteractionChannel: interaction.channel };
        guildQueues.set(guildId, queue);
    } else {
        queue.lastInteractionChannel = interaction.channel;
    }

    // Playlist check (nur echte Playlists, kein einzelnes Video in Playlist)
    if (isYouTubePlaylistUrl(url) && !url.includes("v=")) {
        const { playlistTitle, entries } = await getPlaylistEntries(url);
        for (const e of entries) queue.songs.push({
            requesterId: interaction.user.id,
            title: e.title,
            filepath: null,
            url: e.url,
            duration: e.duration,
            playlistTitle
        });
        await interaction.followUp(`➕ Playlist **${playlistTitle}** mit ${entries.length} Einträgen zur Queue hinzugefügt.`);
        if (queue.player.state.status !== AudioPlayerStatus.Playing) 
            await ensureNextTrackDownloadedAndPlay(guildId);
         return;
    }   



// Cache check
if (audioCache.has(url)) {
    const filepath = audioCache.get(url);
    const cachedMeta = audioCache.cache.get(audioCache.makeKeyFromUrl(url))?.meta || {};
    const title = cachedMeta.title || path.basename(filepath);
    // hier Dauer prüfen
    let duration = cachedMeta.duration;
    if (!duration && filepath && fs.existsSync(filepath)) {
        // fallback: versuche Metadata aus yt-dlp
        try {
            const info = await getVideoInfo(url);
            duration = info.duration || "unbekannt";
        } catch {
            duration = "unbekannt";
        }
    } else if (!duration) duration = "unbekannt";

    queue.songs.push({ requesterId: interaction.user.id, title, filepath, url, duration });
    await interaction.followUp(`🎵 Aus Cache hinzugefügt: [${title}](${url}) — \`${duration}\``);

    if (queue.player.state.status !== AudioPlayerStatus.Playing) 
        await ensureNextTrackDownloadedAndPlay(guildId);
    return;
}


    // Async download with progress embed
    const tempFilename = `song_${Date.now()}_${randomUUID().slice(0,8)}.m4a`;
    const filepath = path.join(DOWNLOAD_DIR, tempFilename);

    // Get video info first
    let video;
    try {
        video = await getVideoInfo(url);
    } catch (err) {
        console.error("[VIDEO INFO ERROR]", err.message);
        return await safeFollowUp(interaction, `❌ Konnte Video-Info nicht abrufen: ${err.message}`);
    }

    // Sammle alle Nachrichten für späteres Löschen
    const downloadMessages = [];

    // Erste Nachricht: Download gestartet
    const startMsg = await interaction.followUp("⬇️ Download gestartet, ich informiere dich, wenn das Lied bereit ist.");
    downloadMessages.push(startMsg);

    // Progress embed
    let progressEmbed = new EmbedBuilder()
        .setTitle("⬇️ Download läuft...")
        .setDescription(`0% abgeschlossen`)
        .setColor(0x1DB954);

    let progressMsg = await interaction.followUp({ embeds: [progressEmbed] });
    downloadMessages.push(progressMsg);
    

    // Progress callback every 5%
    // Progress callback (akzeptiert sowohl String als auch Objekt)
    const progressCb = (data) => {
        try {
            // extrahiere Prozent (unterstützt: { percent, raw }, oder reiner String)
            let percent = null;

            if (data && typeof data === "object") {
                // objekt-form (downloadSingleTo sendet so)
                if (typeof data.percent === "number") {
                    percent = data.percent;
                } else if (typeof data.raw === "string") {
                    const m = data.raw.match(/\[download\]\s+(\d{1,3}\.\d)%/);
                    if (m) percent = parseFloat(m[1]);
                }
            } else if (typeof data === "string") {
                // string-form (falls irgendwas string-Only sendet)
                const m = data.match(/\[download\]\s+(\d{1,3}\.\d)%/);
                if (m) percent = parseFloat(m[1]);
            }

            if (percent !== null && !isNaN(percent)) {
                // update bereits abstand-basiert (5% für weniger Spam)
                if (!progressCb.lastPercent || percent - progressCb.lastPercent >= 5) {
                    progressCb.lastPercent = percent;
                    try {
                        progressEmbed.setDescription(`${percent.toFixed(0)}% abgeschlossen`);
                        progressMsg.edit({ embeds: [progressEmbed] }).catch(()=>{});
                        console.log(`[PROGRESS] ${percent.toFixed(1)}% completed`);
                    } catch (e) { 
                        console.warn("[PROGRESS UPDATE ERROR]", e.message);
                    }
                }
            } else {
                console.log(`[PROGRESS DEBUG] No valid percent found in:`, data);
            }
        } catch (e) {
            // safe-ignore parsing problems
            console.warn("[PROGRESS CB ERROR]", e && e.message ? e.message : e);
        }
    };
    progressCb.lastPercent = 0;

    const downloadPromise = downloadSingleTo(filepath, url, progressCb)
        .then(res => {
            // Write to cache with proper metadata
            audioCache.set(url, filepath, { title: video.title, duration: video.duration });
            return { filepath };
        });

    downloadPromise.then(async ({ filepath: fp }) => {
        queue.songs.push({
            requesterId: interaction.user.id,
            title: video.title,
            filepath: fp,
            url,
            duration: video.duration
        });
        const finishMsg = await safeFollowUp(interaction, `✅ Download fertig: **${video.title}** — zur Queue hinzugefügt.`);
        downloadMessages.push(finishMsg);
        
        // Lösche alle Download-Nachrichten nach 1 Minute
        setTimeout(async () => {
            for (const msg of downloadMessages) {
                try {
                    if (msg && msg.delete) {
                        await msg.delete();
                    }
                } catch (e) {
                    // Ignoriere Fehler beim Löschen (z.B. Nachricht bereits gelöscht)
                }
            }
        }, 60000); // 60 Sekunden
        
        if (queue.player.state.status !== AudioPlayerStatus.Playing) await ensureNextTrackDownloadedAndPlay(guildId);
    }).catch(async (err) => {
        console.error("[DOWNLOAD ERROR]", err.message);
        const errorMsg = await safeFollowUp(interaction, `❌ Download fehlgeschlagen: ${err.message}`);
        downloadMessages.push(errorMsg);
        
        // Lösche auch bei Fehlern nach 1 Minute
        setTimeout(async () => {
            for (const msg of downloadMessages) {
                try {
                    if (msg && msg.delete) {
                        await msg.delete();
                    }
                } catch (e) {
                    // Ignoriere Fehler beim Löschen
                }
            }
        }, 60000);
    });
}



// --------------------------- Ensure next track downloaded & play ---------------------------
async function ensureNextTrackDownloadedAndPlay(guildId) {
    const q = guildQueues.get(guildId);
    if (!q) return;
    if (q.songs.length === 0) {
        // nothing left -> cleanup connection
        try { q.connection.destroy(); } catch {}
        guildQueues.delete(guildId);
        return;
    }

    // If current player already playing, do nothing
    if (q.player.state.status === AudioPlayerStatus.Playing) return;

    // get next track (peek)
    const next = q.songs[0];
    if (!next) return;

    // if filepath exists -> play immediately
    if (next.filepath && fs.existsSync(next.filepath)) {
        playNextInGuild(guildId);
        return;
    }

    // else we need to download the next.url (lazy)
    if (!next.url) {
        // invalid entry -> drop and try next
        q.songs.shift();
        return ensureNextTrackDownloadedAndPlay(guildId);
    }

    // build filepath
    const filename = `song_${Date.now()}_${randomUUID().slice(0,8)}.m4a`;
    const filepath = path.join(DOWNLOAD_DIR, filename);

    // optional notify channel
    if (q.lastInteractionChannel) {
        q.lastInteractionChannel.send(`⬇️ Lade: ${truncateMessage(next.title || next.url, 80)}`).catch(() => {});
    }

    try {
        // download (synchronous in promise but does not block event loop)
        await downloadSingleTo(filepath, next.url, /*progressCb*/ () => {});
        audioCache.set(next.url, filepath, { title: next.title, duration: next.duration });
        next.filepath = filepath;
        // play
        playNextInGuild(guildId);
    } catch (e) {
        console.error("[NEXT DOWNLOAD ERROR]", e?.message || e);
        // notify and remove track
        if (q.lastInteractionChannel) q.lastInteractionChannel.send(`⚠️ Fehler beim Laden von ${next.title || next.url}: ${e.message}`).catch(()=>{});
        q.songs.shift();
        // try next
        return ensureNextTrackDownloadedAndPlay(guildId);
    }
}

// --------------------------- Play next (consumes queue) ---------------------------
function playNextInGuild(guildId) {
    const q = guildQueues.get(guildId);
    if (!q) return;
    const track = q.songs.shift();
    if (!track) return;
    const resource = createAudioResource(track.filepath, { inlineVolume: true });
    resource.volume.setVolume((q.volume || 50) / 100);
    q.player.play(resource);

    // Send now playing embed to a stored textChannel if present
    if (q.lastInteractionChannel) {
        try {
            const embed = new EmbedBuilder()
                .setTitle("Now Playing")
                .setDescription(`[${track.title || path.basename(track.filepath)}](${track.url})`) // <-- Hotlink hier
                .addFields(
                    { name: "Dauer", value: track.duration || "unbekannt", inline: true },
                    { name: "Angefragt von", value: `<@${track.requesterId}>`, inline: true },
                )
                .setTimestamp();

            if (track.playlistTitle) embed.addFields({ name: "Playlist", value: track.playlistTitle, inline: false });

            q.lastInteractionChannel.send({ embeds: [embed] }).then(msg => {
                // Speichere die "Now Playing" Nachricht für spätere Löschung
                q.nowPlayingMessage = msg;
            }).catch(() => {});
        } catch (e) {
            console.warn("[EMBED SEND ERROR]", e.message);
        }
    }

    console.log(`[PLAY][${guildId}] Playing: ${track.title || track.filepath}`);
}


// --------------------------- Process errors ---------------------------
process.on("uncaughtException", err => console.error("[FATAL]", err && err.stack ? err.stack : err));
process.on("unhandledRejection", r => console.error("[UNHANDLED REJECTION]", r));

// --------------------------- Start ---------------------------
ensureDir(DOWNLOAD_DIR);
if (!TOKEN) {
    console.error("TOKEN environment variable not set. Exiting.");
    process.exit(1);
}
client.login(TOKEN).catch(err => console.error("Login failed:", err?.message || err));
