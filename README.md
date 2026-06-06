# 🎵 Discord Musicbot

A self-hosted Discord music bot powered by yt-dlp with slash commands and Docker support.

## Features

- **Multi-Platform** — YouTube, SoundCloud, Bandcamp, Twitch, Vimeo and [all yt-dlp sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
- **Search & Select** — `/play <query>` shows 10 results, `/select <nr>` picks one
- **Playlist Support** — YouTube playlists with background downloading and progress display
- **Now Playing UI** — Interactive embed with ⏮️⏯️⏭️🔉🔊 buttons
- **Audio Cache** — LRU file cache with configurable size, persisted to disk
- **Local Mapping Playback** — `/playchrist` queues local audio files from `mapping/`
- **Repeat & Shuffle** — Song loop, queue loop, shuffle mode
- **Rate Limiting** — 10 downloads/user/minute
- **Graceful Shutdown** — Clean voice disconnects on container stop

## Setup

### 1. Create a Bot Token

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Create a Bot → copy the token
3. OAuth2 → URL Generator: Scopes `bot` + `applications.commands`, Permissions: `Connect`, `Speak`, `Send Messages`
4. Invite the bot to your server

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` — at minimum set `TOKEN`:

```env
TOKEN=your_bot_token
MAX_CACHE=200
DOWNLOAD_TIMEOUT_SEC=120
LOG_LEVEL=info
DOWNLOAD_HOST_PATH=./downloads
MAPPING_HOST_PATH=./mapping
```

### 3. Run (Docker)

```bash
docker compose up -d --build
```

View logs:
```bash
docker compose logs -f musicbot
```

yt-dlp is automatically updated on every container start and checked every 6 hours.

## Commands

| Command | Description |
|---------|-------------|
| `/play <query/url>` | Play a song, playlist or start a search |
| `/select <1-10>` | Pick a search result |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/skip` | Skip current song |
| `/stop` | Stop playback and clear queue |
| `/queue` | Show current queue |
| `/volume <0-100>` | Set volume |
| `/shuffle` | Toggle shuffle mode |
| `/repeatsingle` | Repeat current song |
| `/repeat` | Repeat entire queue |
| `/playcache` | Play all cached songs |
| `/playchrist` | Play all audio files from the `mapping/` folder |
| `/leave` | Disconnect bot from voice |
| `/debug` | Show debug info |
| `/clearcache` | Clear audio cache (Admin) |
| `/refresh` | Re-register slash commands (Admin) |

## Architecture

```
src/
├── index.js                 # Entry point, slash commands, events
├── commands/
│   └── commandHandlers.js   # All command handlers
├── queue/
│   └── QueueManager.js      # Queue & playback (ffmpeg PCM buffering)
├── download/
│   ├── ytdlp.js             # yt-dlp wrapper
│   ├── BackgroundDownloader.js
│   ├── ProgressManager.js
│   └── RateLimiter.js
├── cache/
│   ├── AudioCache.js        # LRU file cache
│   └── SearchCache.js
├── voice/
│   └── VoiceManager.js      # Voice join with retry
├── utils/
│   ├── validation.js        # URL/input security
│   ├── urlCleaner.js         # YouTube URL parsing
│   ├── formatting.js
│   └── logger.js             # Winston logger
└── config/
    └── constants.js          # All configuration values
```

## Security

- URL validation against SSRF (localhost, private IPs, `file://`)
- Shell injection prevented (`shell: false` on all spawns)
- Input sanitization for all user inputs
- Per-user rate limiting
- yt-dlp runs with `nice -n 19` (low CPU priority)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN` | — | Discord bot token **(required)** |
| `MAX_CACHE` | `200` | Max number of cached audio files |
| `DOWNLOAD_TIMEOUT_SEC` | `120` | Download timeout in seconds |
| `SEARCH_TIMEOUT_SEC` | `30` | Search timeout in seconds |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `DOWNLOAD_HOST_PATH` | `./downloads` | Host path for audio cache |
| `MAPPING_HOST_PATH` | `./mapping` | Host path for local audio files used by `/playchrist` |
| `MAPPING_DIR` | `./mapping` locally, `/app/mapping` in Docker | Container/local path read by `/playchrist` |
| `LOGS_HOST_PATH` | `./logs` | Host path for log files |

## License

MIT
