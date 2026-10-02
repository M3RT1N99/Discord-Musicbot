// src/commands/definitions.js
// Slash command definitions — the single source for guild registration and /refresh

const { SlashCommandBuilder } = require('discord.js');

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
    new SlashCommandBuilder().setName("playcache").setDescription("Spielt alle Lieder aus dem Cache ab"),
    new SlashCommandBuilder().setName("playchrist").setDescription("Spielt alle Audiodateien aus /mapping/christ ab"),
    new SlashCommandBuilder().setName("refresh").setDescription("Commands neu registrieren (Admin only)"),
    new SlashCommandBuilder().setName("clearcache").setDescription("Cache leeren (Admin only)"),
    new SlashCommandBuilder().setName("repeatsingle").setDescription("Wiederholt den aktuellen Song"),
    new SlashCommandBuilder().setName("repeat").setDescription("Wiederholt die gesamte Queue")
];

module.exports = {
    commandBuilders
};
