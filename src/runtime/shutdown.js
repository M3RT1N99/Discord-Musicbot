// src/runtime/shutdown.js
// Graceful shutdown on SIGTERM/SIGINT (docker stop): leave voice, flush the cache

const logger = require('../utils/logger');

/**
 * Installs one-shot SIGTERM/SIGINT handlers.
 * @param {object} deps - { client, guildQueues, deleteGuildQueue, audioCache }
 */
function installShutdownHandlers({ client, guildQueues, deleteGuildQueue, audioCache }) {
    let isShuttingDown = false;

    async function gracefulShutdown(signal) {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info(`[SHUTDOWN] Received ${signal}, cleaning up...`);

        // Destroy all voice connections
        for (const [guildId] of guildQueues) {
            try { deleteGuildQueue(guildId); } catch { }
        }

        // Force save cache
        try {
            await audioCache.flush();
        } catch (err) {
            logger.warn(`[SHUTDOWN] Cache flush failed: ${err?.message || err}`);
        }

        // Destroy client
        client.destroy();
        logger.info('[SHUTDOWN] Cleanup complete, exiting.');

        // Wait for logger to flush before exiting
        logger.on('finish', () => process.exit(0));
        logger.end();

        // Fallback: force exit after 3s if logger hangs
        setTimeout(() => process.exit(0), 3000).unref();
    }

    function handleShutdownSignal(signal) {
        gracefulShutdown(signal).catch(err => {
            logger.error(`[SHUTDOWN] Failed: ${err?.message || err}`);
            process.exit(1);
        });
    }

    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
}

module.exports = {
    installShutdownHandlers
};
