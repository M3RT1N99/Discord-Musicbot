#!/bin/sh
set -e

# === yt-dlp Update bei Start ===
echo "========================================"
echo "🔄 Checking yt-dlp for updates..."
echo "========================================"

CURRENT=$(/opt/venv/bin/yt-dlp --version 2>/dev/null || echo "not installed")
echo "📦 Current version: $CURRENT"

/opt/venv/bin/pip install --no-cache-dir --upgrade yt-dlp 2>&1 | tail -1

UPDATED=$(/opt/venv/bin/yt-dlp --version 2>/dev/null || echo "unknown")
echo "✅ yt-dlp version: $UPDATED"

if [ "$CURRENT" != "$UPDATED" ]; then
    echo "🆕 Updated from $CURRENT -> $UPDATED"
else
    echo "👍 Already up to date"
fi

echo "========================================"
echo "🎵 Starting Discord Musicbot..."
echo "========================================"

# === Background Update-Checker (alle 6 Stunden) ===
UPDATE_INTERVAL=${YTDLP_UPDATE_INTERVAL:-21600}  # Default: 6h (21600s)

check_for_updates() {
    while true; do
        sleep "$UPDATE_INTERVAL"
        echo "[UPDATE CHECK] Checking yt-dlp for updates..."
        BEFORE=$(/opt/venv/bin/yt-dlp --version 2>/dev/null)
        /opt/venv/bin/pip install --no-cache-dir --upgrade yt-dlp > /dev/null 2>&1
        AFTER=$(/opt/venv/bin/yt-dlp --version 2>/dev/null)

        if [ "$BEFORE" != "$AFTER" ]; then
            echo "🆕 yt-dlp updated: $BEFORE -> $AFTER — restarting bot..."
            kill $BOT_PID 2>/dev/null || true
            exit 0  # Docker restart policy will restart us
        else
            echo "[UPDATE CHECK] yt-dlp $AFTER — up to date ✓"
        fi
    done
}

# Increase libuv threadpool for better FS performance during playback & download
export UV_THREADPOOL_SIZE=32

# Start bot in background, keep PID
node --max-old-space-size=512 --unhandled-rejections=warn src/index.js &
BOT_PID=$!

# Start update checker in background
check_for_updates &

# Wait for bot process — if it exits, we exit too
wait $BOT_PID
EXIT_CODE=$?
echo "Bot exited with code $EXIT_CODE"
exit $EXIT_CODE
