# Linux runtime: Node 22 + ffmpeg (comes with the ffmpeg-static package) + yt-dlp (for music).
# The Chatterbox local TTS is not part of this image; point LOCAL_TTS_URL at an external server if you need it.
FROM node:22-slim

# The yt-dlp release built into the image: "latest" is the newest one at build time; pin a tag for an
# image that builds the same way twice:  docker build --build-arg YTDLP_VERSION=2025.09.05 .
ARG YTDLP_VERSION=latest

ENV NODE_ENV=production
WORKDIR /app

# python3 runs yt-dlp (the zipapp build, which works on every architecture this image is built for).
# tini is PID 1: node does not reap orphans, and the ffmpeg and yt-dlp children of a skipped or failed
# track would otherwise stay behind as zombies. No curl: node does the download below.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY data/.gitkeep ./data/.gitkeep

# yt-dlp through the bot's own downloader (src/ytdlp.js): checked against the SHA2-256SUMS published in
# the same release before it is made executable, and left root-owned 0755, so the account the bot runs
# as cannot change what it executes.
RUN node --input-type=module -e "import { downloadYtDlp } from './src/ytdlp.js'; await downloadYtDlp('/usr/local/bin/yt-dlp', { version: process.env.YTDLP_VERSION, asset: 'yt-dlp', log: console.log });" \
	&& /usr/local/bin/yt-dlp --version

# The bot runs as the image's unprivileged "node" account (uid 1000) and writes only to /app/data, so a
# host directory mounted there has to be writable by that uid. The panel's key form writes /app/.env,
# which this account cannot; in a container the keys belong in the --env-file.
RUN chown node:node /app/data /app/data/.gitkeep
USER node

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
VOLUME ["/app/data"]

# The panel listens on 127.0.0.1 inside the container, where only the health check below reaches it.
# To open it from the host: set PANEL_HOST=0.0.0.0 and PANEL_TOKEN (16+ characters; beyond loopback the
# panel refuses to start without one), publish the port on the host's loopback only
# (-p 127.0.0.1:8787:8787) and visit http://127.0.0.1:8787/login?token=<PANEL_TOKEN> once. Behind a
# reverse proxy, add the name it forwards to PANEL_ALLOWED_HOSTS.
#
# The health check asks the panel's /healthz (with the token when one is set), reading PANEL,
# PANEL_PORT, PANEL_HOST and PANEL_TOKEN the way the bot does (src/healthcheck.js). With the panel off
# (PANEL=0, or any other off word the bot accepts) there is nothing to ask, so the check passes instead
# of marking a working bot unhealthy; the same goes for PANEL_PORT=0, a port nobody can know.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
	CMD ["node", "src/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
