// src/config/constants.js
// Central configuration for Discord Musicbot

const path = require('path');

// --------------------------- Environment Configuration ---------------------------
const TOKEN = process.env.TOKEN;
const YTDLP_BIN = process.env.YTDLP_PATH || "/opt/venv/bin/yt-dlp";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/muse_downloads";
const MAX_CACHE = parseInt(process.env.MAX_CACHE || "200", 10);
const DOWNLOAD_TIMEOUT_MS = (parseInt(process.env.DOWNLOAD_TIMEOUT_SEC || "120", 10)) * 1000;
const SEARCH_TIMEOUT_MS = (parseInt(process.env.SEARCH_TIMEOUT_SEC || "30", 10)) * 1000;

// --------------------------- Bot Configuration ---------------------------
const JOIN_RETRIES = 2; // retry join attempts on failure
const PROGRESS_EDIT_INTERVAL_MS = 2500; // how often we edit progress message

// --------------------------- Security Configuration ---------------------------
// Blocked URL patterns for security
const BLOCKED_URL_PATTERNS = [
    /localhost/i,
    /127\.0\.0\.1/,
    /192\.168\./,
    /10\./,
    /172\.(1[6-9]|2[0-9]|3[01])\./,
    /169\.254\./,
    /0\.0\.0\.0/,
    /fc00:/,
    /fe80:/,
    /::1/,
    /file:\/\//i,
    /ftp:\/\//i
];

const MAX_QUERY_LENGTH = 500;
const MAX_URL_LENGTH = 2048;

// --------------------------- Rate Limiting ---------------------------
const MAX_DOWNLOADS_PER_USER = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 Minute

// --------------------------- Cache Configuration ---------------------------
const SEARCH_CACHE_TIMEOUT = 1 * 60 * 1000; // 1 Minute

module.exports = {
    // Environment
    TOKEN,
    YTDLP_BIN,
    DOWNLOAD_DIR,
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

    // Cache
    SEARCH_CACHE_TIMEOUT
};
