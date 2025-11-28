// index.js
// Muse — Discord Music Bot (ohne DisTube)
// Features: async yt-dlp downloads, playlist support, lazy downloads, shuffle, now-playing embeds, progress updates, robust voice join

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require("discord.js");
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
const DOWNLOAD_TIMEOUT_MS = (parseInt(process.env.DOWNLOAD_TIMEOUT_SEC || "120", 10)) * 1000; // default 5 min
const JOIN_RETRIES = 2; // retry join attempts on failure
const PROGRESS_EDIT_INTERVAL_MS = 2500; // how often we edit progress message

// --------------------------- Utils ---------------------------
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function truncateMessage(msg, maxLen = 1950) { if (typeof msg !== "string") msg = String(msg); return msg.length > maxLen ? msg.substring(0, maxLen - 3) + "..." : msg; }
function isUrl(s) { try { new URL(s); return true; } catch { return false; } }
function isYouTubePlaylistUrl(u) { try { if (!u) return false; const url = new URL(u); return url.searchParams.has("list"); } catch { return false; } }
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

// --------------------------- Guild Queue System ---------------------------
// guildQueues: Map<guildId, { connection, player, songs: [track], volume, shuffle, lastInteractionChannel }>
const guildQueues = new Map();

function createPlayerForGuild(gid, connection) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on("error", err => console.error(`[PLAYER ERROR][${gid}]`, err?.message || err));
    player.on(AudioPlayerStatus.Idle, () => {
        // ensure next track is downloaded and played (this handles lazy downloads)
        ensureNextTrackDownloadedAndPlay(gid).catch(e => console.error("[ENSURE NEXT ERROR]", e?.message || e));
    });
    return player;
}

// --------------------------- yt-dlp helpers ---------------------------
function spawnYtdlp(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_BIN, args, { ...opts, stdio: ["ignore","pipe","pipe"] });
        let stdout = "", stderr = "";
        proc.stdout.on("data", d => { stdout += d.toString(); });
        proc.stderr.on("data", d => { stderr += d.toString(); });
        const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("yt-dlp timeout")); }, DOWNLOAD_TIMEOUT_MS);
        proc.on("error", err => { clearTimeout(timer); reject(err); });
        proc.on("close", code => { clearTimeout(timer); if (code === 0) resolve({ stdout, stderr, code }); else reject(new Error(`yt-dlp exited ${code}: ${stderr.split("\n").slice(-6).join("\n")}`)); });
    });
}

// Get info JSON for url or search query. Accepts "ytsearch1:..." style query too.
async function getYtdlpInfo(urlOrQuery) {
    // use -J to get JSON
    const args = ["-J", "--no-warnings", "--socket-timeout", "60", urlOrQuery];
    const { stdout } = await spawnYtdlp(args);
    return JSON.parse(stdout);
}

// get playlist entries (full info so we can get durations and thumbnails)
async function getPlaylistEntries(playlistUrl) {
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
    const playlistTitle = json.title || json.playlist_title || "Playlist";
    const entriesRaw = json.entries || [];

    // filter: nur gültige URLs
    const entries = entriesRaw
        .filter(e => e.webpage_url) 
        .map(e => ({
            url: e.webpage_url,
            title: e.title || e.id || "Unbekannt",
            duration: e.duration || null,
            thumbnail: (e.thumbnails && e.thumbnails.length) ? e.thumbnails[e.thumbnails.length-1].url : null
        }));

    return { playlistTitle, entries };
}

// download single video to filepath using yt-dlp (reports stderr progress lines)
// progressCb receives an object { percent, downloaded, eta, speed, raw } when parsed
function downloadSingleTo(filepath, urlOrId, progressCb) {
    return new Promise((resolve, reject) => {
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
        const proc = spawn(YTDLP_BIN, args);
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
    const args = ["-J", "--no-warnings", urlOrId];
    const { stdout } = await spawnYtdlp(args);
    const info = JSON.parse(stdout);
    return {
        title: info.title,
        duration: info.duration ? formatDuration(info.duration) : "unbekannt",
        url: info.webpage_url || info.url
    };
}

// --------------------------- Commands ---------------------------
const commandBuilders = [
    new SlashCommandBuilder()
        .setName("play")
        .setDescription("Spielt einen Song, Link oder Suchbegriff")
        .addStringOption(opt => opt.setName("query").setDescription("YouTube-Link oder Suchbegriff").setRequired(true)),

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
    new SlashCommandBuilder().setName("test").setDescription("Spielt test.mp3 im Container")
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
        await rest.put(Routes.applicationCommands(client.application.id), { body: commandsJson });
        console.log("[COMMANDS] Registered global commands");
    } catch (err) {
        console.error("[COMMANDS] Register failed:", err?.message || err);
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
                if (!memberVoice) return interaction.reply({ content: "Du musst in einem Sprachkanal sein!", ephemeral: true });
                const rawQuery = interaction.options.getString("query", true);
                // initial reply and keep message to edit progress
                await interaction.reply({ content: `🔎 Verarbeite: ${truncateMessage(rawQuery, 100)}`, withResponse: true });
                const replyMsg = await interaction.fetchReply(); // holt die Message danach

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
                if (isYouTubePlaylistUrl(rawQuery)) {
                    await ensureQueueAndJoin();

                    let playlistInfo;
                    try {
                        playlistInfo = await getPlaylistEntries(rawQuery);
                    } catch (e) {
                        // yt-dlp Fehler mit einzelnen Videos ignorieren, falls möglich
                        console.warn("[PLAYLIST READ ERROR]", e.message);
                        return interaction.editReply(`⚠️ Playlist konnte nicht vollständig geladen werden: ${e.message}`);
                    }

                    let { playlistTitle, entries } = playlistInfo;
                    if (!entries || !entries.length) return interaction.editReply("Keine Einträge gefunden.");

                    // Filter: entferne bereits eindeutig fehlerhafte Videos (z.B. keine URL)
                    entries = entries.filter(e => e.url);

                    if (!entries.length) return interaction.editReply("Keine gültigen Einträge in der Playlist gefunden.");

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
                                await interaction.followUp(`⚠️ Fehler bei Track "${entry.title}", überspringe zu "${nextEntry.title}"`);
                                await safePlay(nextEntry);
                            } else {
                                await interaction.followUp("⚠️ Alle Tracks der Playlist fehlerhaft oder nicht verfügbar.");
                            }
                        }
                    }

                    // starte erstes Lied
                    await safePlay(firstEntry);

                    await interaction.followUp(`➕ Playlist **${playlistTitle}** (${entries.length} Einträge) zur Queue hinzugefügt.`);
                    return;
                }


                // If not URL => treat as search (ytsearch1:)
                if (!isUrl(rawQuery)) {
                    let info;
                    try {
                        info = await getYtdlpInfo(`ytsearch1:${rawQuery}`);
                    } catch (e) {
                        console.warn("[YTDLP SEARCH ERROR]", e?.message || e);
                        return interaction.editReply(`❌ Suche fehlgeschlagen: ${e.message}`);
                    }
                    // info may be a search result => pick first
                    const videoUrl = info?.entries ? info.entries[0]?.webpage_url || info.entries[0]?.url : info?.webpage_url || info?.url;
                    if (!videoUrl) return interaction.editReply("Keine Ergebnisse gefunden.");
                    // continue as URL
                    return await handleSingleUrlPlay(interaction, videoUrl, replyMsg);
                }

                // direct url
                return await handleSingleUrlPlay(interaction, rawQuery, replyMsg);
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
                queue.player.stop(); // triggers Idle -> next track
                return interaction.reply("⏭️ Übersprungen.");
            }

            case "stop": {
                if (!queue) return interaction.reply("Keine Musik läuft.");
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

            default:
                return interaction.reply("Unbekannter Befehl.");
        }
    } catch (err) {
        console.error("[INTERACTION ERROR]", err);
        try {
            if (!interaction.replied) await interaction.reply(truncateMessage(`Fehler: ${err.message}`));
            else await interaction.followUp(truncateMessage(`Fehler: ${err.message}`));
        } catch {}
    }
});

// --------------------------- Handle single URL play (downloads lazily, progress edits) ---------------------------
async function handleSingleUrlPlay(interaction, url) {
    const guildId = interaction.guildId;
    const memberVoice = interaction.member.voice.channel;
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
        return interaction.followUp(`❌ Konnte Video-Info nicht abrufen: ${err.message}`);
    }

    // Initial embed
    let progressEmbed = new EmbedBuilder()
        .setTitle("⬇️ Download läuft...")
        .setDescription(`0% abgeschlossen`)
        .setColor(0x1DB954);

    let progressMsg = await interaction.followUp({ embeds: [progressEmbed] });
    

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
                // update bereits abstand-basiert (1% für feineres Feedback)
                if (!progressCb.lastPercent || percent - progressCb.lastPercent >= 5) {
                    progressCb.lastPercent = percent;
                    try {
                        progressEmbed.setDescription(`⬇️ ${percent.toFixed(0)}% abgeschlossen`);
                        progressMsg.edit({ embeds: [progressEmbed] }).catch(()=>{});
                    } catch (e) { /* ignore message edit errors */ }
                }
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

    await interaction.followUp("⬇️ Download gestartet, ich informiere dich, wenn das Lied bereit ist.");

    downloadPromise.then(async ({ filepath: fp }) => {
        queue.songs.push({
            requesterId: interaction.user.id,
            title: video.title,
            filepath: fp,
            url,
            duration: video.duration
        });
        try {
            await interaction.followUp(`✅ Download fertig: **${video.title}** — zur Queue hinzugefügt.`);
        } catch {}
        if (queue.player.state.status !== AudioPlayerStatus.Playing) await ensureNextTrackDownloadedAndPlay(guildId);
    }).catch(async (err) => {
        console.error("[DOWNLOAD ERROR]", err.message);
        try { await interaction.followUp(`❌ Download fehlgeschlagen: ${err.message}`); } catch {}
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

            q.lastInteractionChannel.send({ embeds: [embed] }).catch(() => {});
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
