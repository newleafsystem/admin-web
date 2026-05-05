FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/video-assembler/package.json packages/video-assembler/package.json
COPY packages/publishers/package.json packages/publishers/package.json
COPY services/media-renderer/package.json services/media-renderer/package.json

RUN npm ci --omit=dev --workspace @newleaf/media-renderer --include-workspace-root

COPY services/media-renderer/src services/media-renderer/src

WORKDIR /app/services/media-renderer

ENV PORT=8080
CMD ["node", "src/server.js"]
