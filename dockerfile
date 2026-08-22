FROM node:22 AS builder

WORKDIR /app

# Build-Abhängigkeiten für native Module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node Modules mit Build installieren
COPY package*.json ./
RUN npm install --legacy-peer-deps && npm cache clean --force


# === FINAL STAGE ===
FROM node:22

WORKDIR /app

# Runtime-Abhängigkeiten: ffmpeg, python3 + yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    ffmpeg \
    libopus0 \
    libsodium23 \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Dedizierter Non-Root-User nach Unraid-Konvention (nobody:users = 99:100).
# Die Gruppe 'users' (gid 100) existiert im Debian-Basis-Image bereits.
RUN useradd --uid 99 --gid 100 --no-create-home --home-dir /app --shell /usr/sbin/nologin musicbot

# Temp-Verzeichnis für Downloads und lokalen Mapping-Ordner erstellen
RUN mkdir -p /tmp/musicbot_downloads /mapping/christ && \
    chown -R 99:100 /tmp/musicbot_downloads /mapping

# yt-dlp in Virtual Environment installieren (nur im Container).
# chown im selben Layer: der Entrypoint macht zur Laufzeit
# 'pip install --upgrade' ins venv und braucht dafür Schreibrecht.
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
    /opt/venv/bin/pip install --no-cache-dir yt-dlp && \
    chown -R 99:100 /opt/venv

ENV PATH="/opt/venv/bin:$PATH"

# Node Modules aus Builder kopieren
COPY --from=builder --chown=99:100 /app/node_modules ./node_modules

# Quellcode kopieren
COPY --chown=99:100 package*.json ./
COPY --chown=99:100 . .

# Entrypoint script: fix Windows line endings + make executable
# (sed -i legt die Datei neu an, daher erneut chownen). Zusätzlich /app
# selbst sowie die Mount-Punkte für downloads/logs anlegen und an 99:100
# geben (Bind-Mounts von Unraid-Shares sind dort ebenfalls 99:100).
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh && \
    chown 99:100 /app/entrypoint.sh && \
    mkdir -p /app/downloads /app/logs && \
    chown 99:100 /app /app/downloads /app/logs

# Node.js Output unbuffered machen für echte Logs
ENV NODE_OPTIONS=--unhandled-rejections=warn
ENV FORCE_COLOR=1
ENV NODE_BUFFER_SIZE=16777216

# Als Non-Root-User laufen; HOME=/app ist für uid 99 schreibbar (u.a. für pip)
ENV HOME=/app
USER musicbot

ENTRYPOINT ["/app/entrypoint.sh"]
