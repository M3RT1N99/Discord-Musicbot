// src/config/constants.js
// Central configuration for Discord Musicbot

// --------------------------- Environment Configuration ---------------------------
const TOKEN = process.env.TOKEN;
const YTDLP_BIN = process.env.YTDLP_PATH || "/opt/venv/bin/yt-dlp";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/musicbot_downloads";
const MAPPING_DIR = process.env.MAPPING_DIR || "/mapping/christ";
const MAX_CACHE = parseInt(process.env.MAX_CACHE || "200", 10);
const DOWNLOAD_TIMEOUT_MS = (parseInt(process.env.DOWNLOAD_TIMEOUT_SEC || "120", 10)) * 1000;
const SEARCH_TIMEOUT_MS = (parseInt(process.env.SEARCH_TIMEOUT_SEC || "30", 10)) * 1000;

// --------------------------- Bot Configuration ---------------------------
const JOIN_RETRIES = 2; // retry join attempts on failure
const PROGRESS_EDIT_INTERVAL_MS = 2500; // how often we edit progress message

// --------------------------- Security Configuration ---------------------------
// Blocked hostname patterns for security (SSRF protection).
// Matched against the parsed, lowercased URL hostname — NOT the full URL string.
// Protocol restrictions (http/https only) are enforced separately in validation.js.
const BLOCKED_URL_PATTERNS = [
    // Local / internal hostnames
    /^localhost$/,
    /\.localhost$/,
    /\.local$/,
    /\.lan$/,
    /\.internal$/,
    /\.home\.arpa$/,
    /^[^.]+$/,                       // single-label hostnames without a dot (e.g. "tower", "nas")

    // Private / reserved IPv4 ranges (anchored)
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^0\./,

    // Alternative IP encodings as complete hostname (e.g. http://2130706433/, http://0x7f000001/)
    /^\d+$/,
    /^0x[0-9a-f]+$/,

    // IPv6 loopback / link-local / unique-local (URL hostname keeps the brackets)
    /^\[::1\]$/,
    /^\[fe80:/,
    /^\[f[cd]/
];

const MAX_QUERY_LENGTH = 500;
const MAX_URL_LENGTH = 2048;

// --------------------------- Rate Limiting ---------------------------
const MAX_DOWNLOADS_PER_USER = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 Minute

// --------------------------- Memory Limits ---------------------------
const MAX_SONGS_PER_QUEUE = 500;
const MAX_SEARCH_CACHE_ENTRIES = 100;
const MAX_PENDING_CHOICES = 50;
const MAX_DOWNLOAD_QUEUE = 200;

// --------------------------- Cache Configuration ---------------------------
const SEARCH_CACHE_TIMEOUT = 1 * 60 * 1000; // 1 Minute

// --------------------------- Local Audio Configuration ---------------------------
const LOCAL_AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".webm", ".aac"];

module.exports = {
    // Environment
    TOKEN,
    YTDLP_BIN,
    DOWNLOAD_DIR,
    MAPPING_DIR,
    MAX_CACHE,
    DOWNLOAD_TIMEOUT_MS,
    SEARCH_TIMEOUT_MS,

    // Bot Config
    JOIN_RETRIES,
    PROGRESS_EDIT_INTERVAL_MS,

    // Security
    BLOCKED_URL_PATTERNS,
    MAX_QUERY_LENGTH,
    MAX_URL_LENGTH,

    // Rate Limiting
    MAX_DOWNLOADS_PER_USER,
    RATE_LIMIT_WINDOW_MS,

    // Memory Limits
    MAX_SONGS_PER_QUEUE,
    MAX_SEARCH_CACHE_ENTRIES,
    MAX_PENDING_CHOICES,
    MAX_DOWNLOAD_QUEUE,

    // Cache
    SEARCH_CACHE_TIMEOUT,

    // Local Audio
    LOCAL_AUDIO_EXTENSIONS
};
