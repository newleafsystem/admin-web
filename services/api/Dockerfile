FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEWLEAF_SKIP_DOTENV=1
ENV LOCAL_DATA_DIR=/tmp/newleaf-api
ENV FFMPEG_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/video-assembler/package.json packages/video-assembler/package.json
COPY packages/publishers/package.json packages/publishers/package.json
COPY services/media-renderer/package.json services/media-renderer/package.json

RUN npm ci --omit=dev --workspace @newleaf/api --include-workspace-root

COPY apps/api apps/api
COPY docs/service-api-openapi.yaml docs/service-api-openapi.yaml
COPY packages/video-assembler packages/video-assembler
COPY packages/publishers packages/publishers

WORKDIR /app/apps/api

CMD ["npm", "run", "start"]
