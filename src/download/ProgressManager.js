// src/download/ProgressManager.js
// Download progress parsing and display

/**
 * Helper class for unified progress parsing and display
 */
class DownloadProgressManager {
    constructor() {
        this.lastPercent = 0;
        this.lastUpdate = 0;
        this.UPDATE_INTERVAL = 2500;
    }

    /**
     * Parses progress data from yt-dlp output
     * @param {string|object} data - Progress data
     * @returns {object|null} Parsed progress { percent, speed, eta }
     */
    parseProgress(data) {
        if (!data) return null;
        if (typeof data === "string") data = { raw: data };

        let percent = null;
        let speed = null;
        let eta = null;

        if (typeof data.percent === "number") {
            percent = data.percent;
        } else if (typeof data.raw === "string") {
            const raw = data.raw;
            // Optimized patterns
            const patterns = [
                // [download]   2.3% of  227.22MiB at  100.00KiB/s ETA 37:53
                /\[download\]\s+(\d+(?:\.\d+)?)\%\s+of\s+[\w\.~]+\s+at\s+([\w\.\/]+)\s+ETA\s+(\d+:\d+(?::\d+)?)/,
                // [download] 100% of  227.22MiB in 00:00:05 at 40.63MiB/s
                /\[download\]\s+(\d+(?:\.\d+)?)\%\s+of\s+[\w\.~]+\s+in\s+[\d:]+\s+at\s+([\w\.\/]+)/,
                // Fallback
                /(\d+(?:\.\d+)?)\%/
            ];

            for (const pattern of patterns) {
                const match = raw.match(pattern);
                if (match) {
                    percent = parseFloat(match[1]);
                    speed = match[2] || data.speed;
                    eta = match[3] || data.eta;
                    break;
                }
            }
        }

        if (percent !== null && !isNaN(percent)) {
            return { percent, speed, eta };
        }
        return null;
    }

    /**
     * Checks if progress should be updated (throttling)
     * @param {number} percent - Current progress percentage
     * @returns {boolean} True if should update
     */
    shouldUpdate(percent) {
        const now = Date.now();
        const timeDiff = now - this.lastUpdate;
        const percentDiff = percent - this.lastPercent;

        if (percent === 100 || (percentDiff >= 5 && timeDiff > this.UPDATE_INTERVAL) || !this.lastUpdate) {
            this.lastPercent = percent;
            this.lastUpdate = now;
            return true;
        }
        return false;
    }

    /**
     * Creates ASCII progress bar
     * @param {number} percent - Progress percentage
     * @returns {string} Progress bar string
     */
    createProgressBar(percent) {
        const total = 15;
        const progress = Math.round((percent / 100) * total);
        const empty = total - progress;
        return `[${'='.repeat(progress)}${' '.repeat(empty)}]`;
    }

    /**
     * Resets progress state
     */
    reset() {
        this.lastPercent = 0;
        this.lastUpdate = 0;
    }
}

module.exports = DownloadProgressManager;
