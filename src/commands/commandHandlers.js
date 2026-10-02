// src/commands/commandHandlers.js
// Entry point for all interaction handlers — index.js routes to these.
// The handlers live in feature modules next to this file.

const { handlePlayCommand, handleSelectCommand, handleSearchSelect } = require('./play');
const { handlePauseCommand, handleResumeCommand, handleSkipCommand, handleStopCommand, handleQueueCommand, handleVolumeCommand, handleLeaveCommand, handleShuffleCommand, handleRepeatSingleCommand, handleRepeatCommand } = require('./playback');
const { handleTestCommand, handleDebugCommand, handleRefreshCommand, handleClearcacheCommand } = require('./maintenance');
const { handlePlaycacheCommand, handlePlaychristCommand } = require('./library');
const { handlePlaylistChoiceButton } = require('./playlistChoice');
const { handleNowPlayingButton } = require('./nowPlayingButtons');

module.exports = {
    handlePlayCommand,
    handleSelectCommand,
    handleSearchSelect,
    handlePauseCommand,
    handleResumeCommand,
    handleSkipCommand,
    handleStopCommand,
    handleQueueCommand,
    handleVolumeCommand,
    handleLeaveCommand,
    handleShuffleCommand,
    handleTestCommand,
    handleDebugCommand,
    handlePlaycacheCommand,
    handlePlaychristCommand,
    handleRefreshCommand,
    handleClearcacheCommand,
    handleRepeatSingleCommand,
    handleRepeatCommand,
    handlePlaylistChoiceButton,
    handleNowPlayingButton
};
