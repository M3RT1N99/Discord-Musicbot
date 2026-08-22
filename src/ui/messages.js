// src/ui/messages.js
// Central UI builders: one consistent look for everything the bot sends.
// Colors, bars and card layouts live here — handlers only pass data in.

const {
    EmbedBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ThumbnailBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const { formatDuration } = require('../utils/formatting');

// Palette: violet = playback/brand, neutral = info (blends into dark theme),
// amber = paused/warning, green/red only for success/error.
const COLORS = {
    ACCENT: 0x8D5CF6,
    NEUTRAL: 0x2B2D31,
    SUCCESS: 0x43B581,
    WARN: 0xFAA61A,
    ERROR: 0xED4245
};

/**
 * 10-segment progress/volume bar: ▰▰▰▰▱▱▱▱▱▱
 * @param {number} percent - 0-100
 * @returns {string} Bar string
 */
function bar(percent) {
    const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10);
    return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/**
 * Derives a thumbnail URL for a track (explicit thumbnail, else YouTube video id)
 * @param {object} track - Track object
 * @returns {string|null} Thumbnail URL or null
 */
function trackThumbnail(track) {
    if (track?.thumbnail) return track.thumbnail;
    if (!track?.url) return null;
    try {
        const u = new URL(track.url);
        let id = null;
        if (u.hostname.includes('youtu.be')) {
            id = u.pathname.split('/').filter(Boolean)[0] || null;
        } else if (u.hostname.includes('youtube.com')) {
            id = u.searchParams.get('v');
        }
        if (id && /^[\w-]{11}$/.test(id)) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    } catch { }
    return null;
}

/**
 * Escapes markdown-sensitive characters in titles so they render as plain text
 * @param {string} text - Raw title
 * @returns {string} Escaped title
 */
function mdEscape(text) {
    return String(text ?? '').replace(/([\\*_~`|])/g, '\\$1');
}

/**
 * Renders a duration for display: numeric seconds get formatted (yt-dlp playlist
 * entries deliver raw numbers), strings pass through unchanged.
 * @param {number|string|null} duration - Duration value
 * @returns {string|null} Display string or null
 */
function fmtDur(duration) {
    if (duration == null || duration === '') return null;
    return typeof duration === 'number' ? formatDuration(duration) : String(duration);
}

/**
 * Slices a string to max UTF-16 code units (Discord's limit unit) without
 * ever ending on a lone high surrogate (half an emoji).
 * @param {string} str - Input
 * @param {number} max - Maximum length in code units
 * @returns {string} Sliced string
 */
function safeSlice(str, max) {
    let s = String(str ?? '').slice(0, max);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) s = s.slice(0, -1);
    return s;
}

function loopLabel(loopMode) {
    if (loopMode === 'song') return '🔂 Song-Loop';
    if (loopMode === 'queue') return '🔁 Queue-Loop';
    return null;
}

/**
 * Builds the Now Playing card (Components V2 container with controls).
 * The same builder is used for the initial send and for in-place updates
 * from button presses, so the card always reflects the live queue state.
 * @param {string} guildId - Guild ID (for button custom ids)
 * @param {object} queue - Guild queue
 * @param {object} track - Currently playing track
 * @returns {ContainerBuilder} Container component
 */
function buildNowPlayingCard(guildId, queue, track) {
    const paused = ['paused', 'autopaused'].includes(queue.player?.state?.status);
    const title = mdEscape(track.title || 'Unbekannt');
    const heading = track.url
        ? `## ${paused ? '⏸️' : '🎶'} [${title}](${track.url})`
        : `## ${paused ? '⏸️' : '🎶'} ${title}`;

    const metaParts = [`von <@${track.requesterId}>`];
    const dur = fmtDur(track.duration);
    if (dur) metaParts.push(`⏱️ ${dur}`);
    if (track.playlistTitle) metaParts.push(`📋 ${mdEscape(track.playlistTitle)}`);

    const vol = queue.volume ?? 50;
    const queueInfo = queue.songs.length > 0
        ? `${queue.songs.length} Song${queue.songs.length > 1 ? 's' : ''} in der Queue`
        : 'Queue leer';
    const statusParts = [`🔊 ${bar(vol)} ${vol} %`, `📋 ${queueInfo}`];
    const loop = loopLabel(queue.loopMode);
    if (loop) statusParts.push(loop);
    if (queue.shuffle) statusParts.push('🔀 Shuffle');
    if (paused) statusParts.push('⏸️ pausiert');

    const headText = new TextDisplayBuilder().setContent(`${heading}\n-# ${metaParts.join(' · ')}`);

    const container = new ContainerBuilder()
        .setAccentColor(paused ? COLORS.WARN : COLORS.ACCENT);

    const thumb = trackThumbnail(track);
    if (thumb) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(headText)
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb))
        );
    } else {
        container.addTextDisplayComponents(headText);
    }

    container
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${statusParts.join(' · ')}`))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`np_prev|${guildId}`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_pause|${guildId}`).setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`np_skip|${guildId}`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_voldn|${guildId}`).setEmoji('🔉').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_volup|${guildId}`).setEmoji('🔊').setStyle(ButtonStyle.Secondary)
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`np_shuffle|${guildId}`).setLabel('Shuffle').setEmoji('🔀')
                    .setStyle(queue.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_loop|${guildId}`)
                    .setLabel(queue.loopMode === 'song' ? 'Song-Loop' : queue.loopMode === 'queue' ? 'Queue-Loop' : 'Loop')
                    .setEmoji(queue.loopMode === 'song' ? '🔂' : '🔁')
                    .setStyle(queue.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`np_savequeue|${guildId}`).setLabel('Speichern').setEmoji('💾')
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return container;
}

/**
 * Compact "track added" embed (cache hit or finished download)
 * @param {object} opts - { title, url, duration, note }
 * @returns {EmbedBuilder} Embed
 */
function trackAddedEmbed({ title, url, duration, note }) {
    const name = mdEscape(title || 'Unbekannt');
    const line = url ? `**[${name}](${url})**` : `**${name}**`;
    const dur = fmtDur(duration);
    const embed = new EmbedBuilder()
        .setDescription(`➕ ${line}${dur ? ` · ⏱️ ${dur}` : ''}`)
        .setColor(COLORS.NEUTRAL);
    if (note) embed.setFooter({ text: note });
    return embed;
}

/**
 * Download progress embed (single track)
 * @param {object} opts - { title, percent, speed, eta }
 * @returns {EmbedBuilder} Embed
 */
function downloadProgressEmbed({ title, percent = 0, speed, eta }) {
    // percent === null: no progress source (lazy between-track download) —
    // show a plain "wird geladen" line instead of a frozen 0 % bar
    const parts = percent == null ? ['wird geladen…'] : [`${bar(percent)} ${percent.toFixed(0)} %`];
    if (speed) parts.push(speed);
    if (eta) parts.push(`ETA ${eta}`);
    return new EmbedBuilder()
        .setDescription(`⬇️ **${mdEscape(title || 'Download')}**\n-# ${parts.join(' · ')}`)
        .setColor(COLORS.NEUTRAL);
}

/**
 * Playlist background-download progress embed
 * @param {object} opts - { playlistTitle, trackTitle, percent, speed, downloaded, total }
 * @returns {EmbedBuilder} Embed
 */
function playlistProgressEmbed({ playlistTitle, trackTitle, percent = 0, speed, downloaded, total }) {
    return new EmbedBuilder()
        .setDescription(
            `📥 **${mdEscape(playlistTitle || 'Playlist')}**\n` +
            `Lade: ${mdEscape(trackTitle || '…')}\n` +
            `-# ${bar(percent)} ${percent.toFixed(0)} %${speed ? ` · ${speed}` : ''} · ${downloaded}/${total} Songs bereit`
        )
        .setColor(percent >= 100 ? COLORS.SUCCESS : COLORS.NEUTRAL);
}

/**
 * Playlist added summary embed
 * @param {object} opts - { playlistTitle, added, total, startIndex, limitReached, maxSongs }
 * @returns {EmbedBuilder} Embed
 */
function playlistAddedEmbed({ playlistTitle, added, total, startIndex = 0, limitReached = false, maxSongs }) {
    const lines = [`➕ **${mdEscape(playlistTitle || 'Playlist')}** — ${added}/${total} Songs zur Queue hinzugefügt.`];
    if (startIndex > 0) lines.push(`▶️ Start bei Track #${startIndex + 1}.`);
    if (limitReached) lines.push(`⚠️ Queue-Limit erreicht (max. ${maxSongs}).`);
    return new EmbedBuilder().setDescription(lines.join('\n')).setColor(COLORS.NEUTRAL);
}

/**
 * Queue overview embed
 * @param {object} queue - Guild queue
 * @returns {EmbedBuilder} Embed
 */
function queueEmbed(queue) {
    const lines = [];
    if (queue.currentTrack) {
        const ct = queue.currentTrack;
        const name = mdEscape(ct.title || 'Unbekannt');
        const link = ct.url ? `[${name}](${ct.url})` : name;
        const ctDur = fmtDur(ct.duration);
        lines.push(`▶️ **${link}**${ctDur ? ` · ⏱️ ${ctDur}` : ''}`);
        lines.push('');
    }

    const shown = queue.songs.slice(0, 10);
    shown.forEach((s, i) => {
        const sDur = fmtDur(s.duration);
        const entry = `**${i + 1}.** ${mdEscape(s.title || 'Unbekannt')}${sDur ? ` (${sDur})` : ''}`;
        lines.push(entry);
    });
    if (queue.songs.length === 0) lines.push('-# Queue ist leer — nur der aktuelle Song läuft.');
    if (queue.songs.length > 10) lines.push(`-# … und ${queue.songs.length - 10} weitere`);

    let description = lines.join('\n');
    if (description.length > 4000) description = description.slice(0, 3997) + '…';

    const footerParts = [`${queue.songs.length} Song${queue.songs.length === 1 ? '' : 's'} in der Queue`];
    const loop = loopLabel(queue.loopMode);
    if (loop) footerParts.push(loop);
    if (queue.shuffle) footerParts.push('🔀 Shuffle');

    return new EmbedBuilder()
        .setTitle('📋 Queue')
        .setDescription(description)
        .setFooter({ text: footerParts.join(' · ') })
        .setColor(COLORS.NEUTRAL);
}

/**
 * Search results: embed + select menu to pick a track directly
 * @param {Array} results - Search results ({ index, title, uploader, duration })
 * @param {string} userId - Requesting user (locks the menu to them)
 * @returns {object} { embeds, components }
 */
function searchResultsMessage(results, userId) {
    const lines = results.map(r =>
        `**${r.index}.** ${mdEscape(r.title)}\n-# ${mdEscape(r.uploader || 'Unbekannt')} · ⏱️ ${fmtDur(r.duration) || '?'}`
    );
    let description = lines.join('\n');
    if (description.length > 4000) description = description.slice(0, 3997) + '…';

    const embed = new EmbedBuilder()
        .setTitle('🔎 Suchergebnisse')
        .setDescription(description)
        .setFooter({ text: 'Wähle unten einen Song aus — oder nutze /select <nummer>' })
        .setColor(COLORS.NEUTRAL);

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`search_pick|${userId}`)
        .setPlaceholder('🎵 Song auswählen…')
        .addOptions(results.map(r =>
            new StringSelectMenuOptionBuilder()
                .setLabel(safeSlice(`${r.index}. ${r.title || 'Unbekannt'}`, 90))
                .setDescription(safeSlice(`${safeSlice(r.uploader || 'Unbekannt', 70)} · ${fmtDur(r.duration) || '?'}`, 100))
                .setValue(String(r.index))
        ));

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)]
    };
}

/**
 * Debug info embed
 * @param {object} opts - Debug data
 * @returns {EmbedBuilder} Embed
 */
function debugEmbed({ guildId, voiceChannel, cacheStats, queueCount, bgStats }) {
    return new EmbedBuilder()
        .setTitle('🔧 Debug')
        .setColor(COLORS.NEUTRAL)
        .addFields(
            { name: 'Status', value: '✅ Online', inline: true },
            { name: 'Guild', value: guildId || 'Unbekannt', inline: true },
            { name: 'Voice-Channel', value: voiceChannel ? `${voiceChannel.name}` : '—', inline: true },
            { name: 'Cache', value: `${cacheStats.size}/${cacheStats.maxEntries} (${cacheStats.utilizationPercent} %)`, inline: true },
            { name: 'Aktive Queues', value: String(queueCount), inline: true },
            { name: 'BG-Downloads', value: `${bgStats.queueLength} wartend · ${bgStats.isActive ? 'aktiv' : 'idle'}`, inline: true }
        )
        .setTimestamp();
}

module.exports = {
    COLORS,
    bar,
    mdEscape,
    fmtDur,
    trackThumbnail,
    buildNowPlayingCard,
    trackAddedEmbed,
    downloadProgressEmbed,
    playlistProgressEmbed,
    playlistAddedEmbed,
    queueEmbed,
    searchResultsMessage,
    debugEmbed
};
