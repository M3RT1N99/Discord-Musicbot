// src/runtime/statusFiles.js
// Status files consumed by the container healthcheck and the yt-dlp
// update-checker in entrypoint.sh (defers restarts while queues are active).

const fs = require('fs');
const { Status } = require('discord.js');

/**
 * Writes /tmp/bot_heartbeat and /tmp/bot_active_queues now and every 30 s.
 * @param {Client} client - Discord client
 * @param {Map} guildQueues - Active guild queues
 */
function startStatusFiles(client, guildQueues) {
    const writeStatusFiles = () => {
        // Heartbeat only while the gateway is actually connected — a live event
        // loop with a dead Discord connection must go unhealthy (and must not
        // block yt-dlp update restarts with a stale queue count).
        // Per-shard check: ws.status stays Ready after the first connect even if
        // the gateway later dies — shard.status reflects the live connection.
        const connected = client.ws.shards.size > 0 && client.ws.shards.every(s => s.status === Status.Ready);
        if (connected) fs.promises.writeFile('/tmp/bot_heartbeat', String(Date.now())).catch(() => { });
        fs.promises.writeFile('/tmp/bot_active_queues', String(connected ? guildQueues.size : 0)).catch(() => { });
    };
    writeStatusFiles();
    setInterval(writeStatusFiles, 30000).unref();
}

module.exports = {
    startStatusFiles
};
