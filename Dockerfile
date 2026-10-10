# DFM Signage Hub als Docker-Container (statt auf einem eigenen Raspberry Pi).
# Bauen:   docker build -t dfm-signage-hub .
# Starten: siehe docker-compose.yml und docs/docker.md
# Der Container enthält NUR den Hub (Verwaltung, Datenbank, Medien-Umwandlung). Die Bildschirme bleiben Raspberry Pi mit dem normalen Image.

# ---- 1. Oberfläche bauen, Abhängigkeiten installieren
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY hub/package.json hub/
COPY admin-ui/package.json admin-ui/
COPY setup/package.json setup/
COPY player/agent/package.json player/agent/
RUN npm ci
COPY . .
RUN npm run build:ui && npm prune --omit=dev

# ---- 2. Laufzeit
FROM node:22-bookworm-slim
# ffmpeg: Videos für die Bildschirme umwandeln; poppler-utils: PDF-Seiten zu Bildern
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DFM_CONTAINER=1 DFM_DATA=/data DFM_HTTPS_PORT=8443 DFM_HTTP_PORT=8080 DFM_BASE=/opt/dfm
WORKDIR /opt/dfm
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/hub ./hub
COPY --from=build /app/shared ./shared
COPY --from=build /app/player/agent/lib ./player/agent/lib
COPY --from=build /app/admin-ui/dist ./admin-ui/dist
COPY --from=build /app/assets ./assets
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs
USER node
VOLUME ["/data"]
EXPOSE 8443 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
# Beendet sich der Hub mit Code 75 (Neustart gewünscht), startet Docker ihn neu (restart: unless-stopped)
CMD ["node", "hub/server.js"]
