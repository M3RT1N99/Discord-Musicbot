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

# Der Container laeuft als uid 99 (musicbot): Bind-Mounts ueberdecken die
# Image-Rechte. Ohne Schreibrecht auf /app/downloads waere der Bot still
# funktionsunfaehig (jeder Download EACCES) — lieber sofort klar scheitern.
if ! touch /app/downloads/.write_test 2>/dev/null; then
    echo "❌ FATAL: /app/downloads ist fuer uid $(id -u) nicht beschreibbar."
    echo "   Der Host-Ordner des Bind-Mounts muss uid 99 / gid 100 gehoeren"
    echo "   (Unraid: nobody:users), z.B.: chown -R 99:100 <DOWNLOAD_HOST_PATH>"
    exit 1
fi
rm -f /app/downloads/.write_test

# === Background Update-Checker (alle 6 Stunden) ===
UPDATE_INTERVAL=${YTDLP_UPDATE_INTERVAL:-21600}  # Default: 6h (21600s)

# Datei-Kontrakt mit dem Bot: src/index.js schreibt alle 30s die Zahl
# aktiver Queues nach /tmp/bot_active_queues (reiner Zahlinhalt).
ACTIVE_QUEUES_FILE=/tmp/bot_active_queues
QUEUE_POLL_INTERVAL=60   # beim Warten auf Idle alle 60s pruefen
QUEUE_STALE_SEC=90       # Datei aelter als 90s => Bot meldet nicht mehr, Restart ok
MAX_RESTART_WAIT=21600   # nach spaetestens 6h Warten Restart erzwingen

# 0 (true), wenn ein Restart gefahrlos ist: keine aktiven Queues, oder die
# Datei fehlt bzw. ist stale (Bot haengt/loggt nicht mehr -> Restart ok).
bot_is_idle() {
    [ -f "$ACTIVE_QUEUES_FILE" ] || return 0
    NOW=$(date +%s)
    MTIME=$(stat -c %Y "$ACTIVE_QUEUES_FILE" 2>/dev/null || echo 0)
    if [ $((NOW - MTIME)) -gt "$QUEUE_STALE_SEC" ]; then
        return 0
    fi
    [ "$(cat "$ACTIVE_QUEUES_FILE" 2>/dev/null)" = "0" ]
}

check_for_updates() {
    # Laeuft als Subshell und erbt 'set -e': hier abschalten, damit ein
    # transienter Fehler (z.B. pip-Netzwerkfehler) nur diese Iteration
    # ueberspringt statt den Checker still und dauerhaft zu beenden.
    set +e
    while true; do
        sleep "$UPDATE_INTERVAL"
        echo "[UPDATE CHECK] Checking yt-dlp for updates..."
        BEFORE=$(/opt/venv/bin/yt-dlp --version 2>/dev/null)
        /opt/venv/bin/pip install --no-cache-dir --upgrade yt-dlp > /dev/null 2>&1
        AFTER=$(/opt/venv/bin/yt-dlp --version 2>/dev/null)

        if [ -z "$AFTER" ]; then
            echo "[UPDATE CHECK] Could not determine yt-dlp version — skipping this check"
        elif [ "$BEFORE" != "$AFTER" ]; then
            echo "🆕 yt-dlp updated: $BEFORE -> $AFTER — waiting until playback is idle before restart..."
            WAITED=0
            while ! bot_is_idle; do
                if [ "$WAITED" -ge "$MAX_RESTART_WAIT" ]; then
                    echo "[UPDATE CHECK] Waited ${WAITED}s with active playback — forcing restart now"
                    break
                fi
                sleep "$QUEUE_POLL_INTERVAL"
                WAITED=$((WAITED + QUEUE_POLL_INTERVAL))
            done
            echo "[UPDATE CHECK] Restarting bot..."
            kill -TERM "$BOT_PID" 2>/dev/null
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
UPDATER_PID=$!

# Dieses Skript ist PID 1: TERM/INT an node weiterleiten, damit der
# Graceful-Shutdown-Pfad in src/index.js (Voice-Connections trennen,
# audioCache.flush()) auch bei 'docker stop' laeuft.
INTERRUPTED=0
forward_signal() {
    INTERRUPTED=1
    echo "Received shutdown signal — forwarding SIGTERM to bot (PID $BOT_PID)..."
    kill -TERM "$UPDATER_PID" 2>/dev/null || true
    kill -TERM "$BOT_PID" 2>/dev/null || true
}
trap forward_signal TERM INT

# Update-Checker-Subshell beim Exit immer mit beenden
cleanup() {
    kill -TERM "$UPDATER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for bot process — if it exits, we exit too.
# wait returnt bei Signalzustellung vorzeitig (Status 128+SIG), daher in
# einer Schleife erneut warten, bis der Bot-Prozess wirklich beendet ist.
EXIT_CODE=0
while :; do
    wait "$BOT_PID" && EXIT_CODE=0 || EXIT_CODE=$?
    # Status >128 ist nur dann "wait wurde unterbrochen", wenn unser Trap auch
    # gefeuert hat — sonst wurde das Kind von einem Signal getoetet (z.B.
    # Kernel-OOM-Kill = 137) und der Status ist bereits final.
    if [ "$EXIT_CODE" -le 128 ] || [ "$INTERRUPTED" -eq 0 ]; then
        break
    fi
    INTERRUPTED=0
    if ! kill -0 "$BOT_PID" 2>/dev/null; then
        # Prozess ist beendet, aber der letzte wait wurde vom Trap unterbrochen.
        # Die Shell merkt sich den echten Status des gereapten Kindes — ein
        # weiterer wait liefert ihn. 127 = PID unbekannt (schon vom ersten wait
        # berichtet): dann war der erste Status bereits der echte.
        PREV_CODE=$EXIT_CODE
        wait "$BOT_PID" 2>/dev/null && EXIT_CODE=0 || EXIT_CODE=$?
        [ "$EXIT_CODE" -eq 127 ] && EXIT_CODE=$PREV_CODE
        break
    fi
done

echo "Bot exited with code $EXIT_CODE"
exit $EXIT_CODE
