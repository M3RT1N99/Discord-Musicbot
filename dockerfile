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
    nodejs \
    libopus0 \
    libsodium23 \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Temp-Verzeichnis für Downloads erstellen
RUN mkdir -p /tmp/muse_downloads

# yt-dlp in Virtual Environment installieren (nur im Container)
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
    /opt/venv/bin/pip install --no-cache-dir yt-dlp

ENV PATH="/opt/venv/bin:$PATH"

# Node Modules aus Builder kopieren
COPY --from=builder /app/node_modules ./node_modules

# Quellcode kopieren
COPY package*.json ./
COPY . .

# Node.js Output unbuffered machen für echte Logs
ENV NODE_OPTIONS=--unhandled-rejections=warn
ENV FORCE_COLOR=1
ENV NODE_BUFFER_SIZE=16777216

CMD ["node", "--max-old-space-size=512", "--unhandled-rejections=warn", "index.js"]
