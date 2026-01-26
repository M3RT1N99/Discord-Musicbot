# 🎵 Discord Musicbot - Quick Start

## Option 1: Mit Docker Compose (Empfohlen)

### 1. Token konfigurieren
Bearbeite `.env` und füge deinen Discord Bot Token ein:
```bash
TOKEN=dein_bot_token_hier
```

### 2. Bot starten
```bash
docker-compose up -d
```

### 3. Logs ansehen
```bash
docker-compose logs -f
```

Fertig! Der Bot läuft jetzt.

Mehr Details: [DOCKER.md](DOCKER.md)

---

## Option 2: Lokal (Development)

### 1. Dependencies installieren
```bash
npm install
```

### 2. Winston installieren (neue Dependency)
```bash
npm install winston
```

### 3. Umgebungsvariablen setzen
Kopiere `.env.example` zu `.env` (falls noch nicht vorhanden):
```bash
cp .env.example .env
```

Bearbeite `.env`:
```bash
TOKEN=dein_bot_token_hier
YTDLP_PATH=/usr/local/bin/yt-dlp  # Pfad zu yt-dlp
DOWNLOAD_DIR=/tmp/muse_downloads
```

### 4. yt-dlp installieren
```bash
# macOS
brew install yt-dlp

# Linux
pip install yt-dlp

# Windows
# Download von https://github.com/yt-dlp/yt-dlp/releases
```

### 5. Bot starten
```bash
npm start

# Oder mit Auto-Reload für Development
npm run dev
```

---

## 📋 Nächste Schritte

1. **Invite Bot** zu deinem Discord Server
2. **Commands registrieren** (passiert automatisch beim Start)
3. **Musik abspielen**: `/play bohemian rhapsody`

## 🎮 Wichtige Commands

| Command | Beschreibung |
|---------|--------------|
| `/play <query>` | Spielt Song/URL/Playlist |
| `/select <nummer>` | Wählt aus Suchergebnissen |
| `/pause` / `/resume` | Pausiert/Fortsetzt |
| `/skip` | Überspringt aktuellen Song |
| `/queue` | Zeigt Queue an |
| `/volume <0-100>` | Setzt Lautstärke |
| `/shuffle` | Shuffle ein/aus |
| `/stop` | Stoppt und leert Queue |
| `/debug` | Debug-Informationen |

## 🔧 Troubleshooting

### Bot startet nicht
- Prüfe TOKEN in `.env`
- Prüfe Logs: `docker-compose logs` oder Console-Output
- Stelle sicher dass Node.js v18+ installiert ist (lokal)

### Commands erscheinen nicht
- Warte 1-2 Minuten (Registrierung dauert)
- Kicke und re-invite den Bot
- Prüfe Bot-Permissions

### Musik spielt nicht
- Bot muss im Voice Channel sein
- Prüfe ob yt-dlp funktioniert: `yt-dlp --version`
- Prüfe Internet-Verbindung

## 📚 Weitere Dokumentation

- **[DOCKER.md](DOCKER.md)** - Docker Deployment-Guide
- **[FEATURES.md](FEATURES.md)** - Alle Features
- **[SECURITY.md](SECURITY.md)** - Sicherheitsrichtlinien
- **[walkthrough.md](walkthrough.md)** - Refactoring Details

## 🆘 Hilfe

Bei Problemen:
1. Prüfe Logs
2. Siehe [DOCKER.md](DOCKER.md) für Docker-Troubleshooting
3. Öffne ein Issue auf GitHub

---

**Viel Spaß mit deinem Musicbot! 🎵**
