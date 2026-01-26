# Docker Setup für Discord Musicbot

## 🚀 Schnellstart

### 1. Token konfigurieren

Bearbeite die `.env` Datei und füge deinen Discord Bot Token ein:

```env
DISCORD_TOKEN=dein_bot_token_hier
```

### 2. Bot starten

```bash
docker-compose up -d
```

Das war's! Der Bot läuft jetzt im Hintergrund.

## 📋 Verfügbare Befehle

### Container Management

```bash
# Bot starten
docker-compose up -d

# Bot stoppen
docker-compose down

# Logs anzeigen
docker-compose logs -f musicbot

# Bot neu starten
docker-compose restart musicbot

# Container neu bauen (nach Code-Änderungen)
docker-compose build --no-cache
docker-compose up -d
```

### Logs und Debugging

```bash
# Live-Logs verfolgen
docker-compose logs -f

# Letzte 100 Zeilen anzeigen
docker-compose logs --tail=100 musicbot

# In laufenden Container einsteigen
docker-compose exec musicbot sh
```

### Status prüfen

```bash
# Container-Status
docker-compose ps

# Ressourcen-Nutzung
docker stats discord-musicbot
```

## 🔧 Konfiguration

### Umgebungsvariablen

Die `docker-compose.yml` verwendet folgende Umgebungsvariablen:

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `DISCORD_TOKEN` | - | Discord Bot Token (ERFORDERLICH) |
| `YTDLP_PATH` | `/opt/venv/bin/yt-dlp` | Pfad zu yt-dlp |
| `DOWNLOAD_DIR` | `/app/downloads` | Download-Verzeichnis |
| `MAX_CACHE` | `200` | Maximale Cache-Größe |
| `DOWNLOAD_TIMEOUT_SEC` | `120` | Download-Timeout in Sekunden |
| `SEARCH_TIMEOUT_SEC` | `30` | Such-Timeout in Sekunden |
| `LOG_LEVEL` | `info` | Logging-Level (debug, info, warn, error) |

### Volumes

Der Container verwendet persistente Volumes:

- `musicbot-downloads`: Gecachte Audio-Dateien
- `musicbot-logs`: Log-Dateien

Daten bleiben auch nach `docker-compose down` erhalten.

### Volumes komplett löschen

```bash
docker-compose down -v
```

⚠️ **Warnung**: Dies löscht ALLE gecachten Dateien und Logs!

## 🛠️ Entwicklung

### Development-Modus

Für lokale Entwicklung kannst du den Source-Code mounten:

Uncomment diese Zeile in `docker-compose.yml`:

```yaml
volumes:
  - ./src:/app/src:ro  # Live-Reload bei Code-Änderungen
```

Dann mit Watch-Modus:

```yaml
command: npm run dev  # Nutzt node --watch
```

### Ohne Docker Compose

Nur mit Dockerfile:

```bash
# Build
docker build -t discord-musicbot .

# Run
docker run -d \
  --name musicbot \
  -e TOKEN=dein_token \
  -v musicbot-downloads:/app/downloads \
  discord-musicbot
```

## 📊 Ressourcen-Limits

Standardmäßig konfiguriert:

- **CPU**: Max 2 Kerne, Min 0.5 Kerne
- **RAM**: Max 1GB, Min 512MB

Anpassen in `docker-compose.yml` unter `deploy.resources`.

## 🐛 Troubleshooting

### Bot startet nicht

```bash
# Logs prüfen
docker-compose logs musicbot

# Häufige Probleme:
# 1. TOKEN nicht gesetzt -> .env prüfen
# 2. Port-Konflikt -> docker-compose ps
# 3. Build-Fehler -> docker-compose build --no-cache
```

### Voice-Verbindung funktioniert nicht

Versuche Host-Networking (bessere Performance):

In `docker-compose.yml` uncomment:

```yaml
network_mode: host
```

⚠️ **Warnung**: Funktioniert nur unter Linux!

### Cache-Probleme

Cache komplett leeren:

```bash
docker-compose exec musicbot rm -rf /app/downloads/*
```

Oder Volume neu erstellen:

```bash
docker-compose down
docker volume rm discord-musicbot_musicbot-downloads
docker-compose up -d
```

### Hoher Speicherverbrauch

Memory-Limit anpassen in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      memory: 512M  # Reduzieren auf 512MB
```

## 🔒 Sicherheit

### Best Practices

1. **.env nicht committen**
   - Ist bereits in `.gitignore`
   - Token niemals öffentlich machen

2. **Eigener User im Container** (Optional)
   ```dockerfile
   # In dockerfile hinzufügen:
   RUN useradd -m -u 1000 musicbot
   USER musicbot
   ```

3. **Read-Only Filesystem** (Optional)
   ```yaml
   # In docker-compose.yml:
   read_only: true
   tmpfs:
     - /tmp
     - /app/downloads
   ```

## 🔄 Updates

### Bot-Code aktualisieren

```bash
git pull origin bot-refactoring
docker-compose build --no-cache
docker-compose up -d
```

### yt-dlp aktualisieren

Im Container:

```bash
docker-compose exec musicbot /opt/venv/bin/pip install --upgrade yt-dlp
docker-compose restart musicbot
```

Oder Dockerfile neu bauen für permanentes Update.

## 📈 Monitoring

### Prometheus Metrics (Optional)

Füge in `docker-compose.yml` hinzu:

```yaml
services:
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
```

### Healthcheck

Der Container hat einen eingebauten Healthcheck:

```bash
docker inspect discord-musicbot | grep -A 10 Health
```

## 🌐 Multi-Guild Deployment

Für mehrere Bots (verschiedene Tokens):

```bash
# bot1
docker-compose -f docker-compose.bot1.yml up -d

# bot2
docker-compose -f docker-compose.bot2.yml up -d
```

Jede Datei mit eigenem `DISCORD_TOKEN` und `container_name`.

## ℹ️ Weitere Infos

- **Logs**: In `/app/logs` im Container (gemounted in `musicbot-logs` Volume)
- **Downloads**: In `/app/downloads` im Container (gemounted in `musicbot-downloads` Volume)
- **yt-dlp**: Läuft in Python venv unter `/opt/venv`

Bei Problemen: Siehe [walkthrough.md](walkthrough.md) oder [SECURITY.md](SECURITY.md)
