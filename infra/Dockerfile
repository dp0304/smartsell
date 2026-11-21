FROM node:24.21.0-trixie-slim
# Media inputs use the seekable fd protocol, which Bookworm's FFmpeg 5 lacks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/ packages/
RUN pnpm --filter @smartsell/server... --filter @smartsell/identity... install --frozen-lockfile --prod
COPY apps/server/src apps/server/src
COPY apps/public/src apps/public/src
COPY apps/public/assets/traffic.css apps/public/assets/traffic.css
COPY tsconfig.base.json ./
COPY infra/start.sh infra/start.sh
RUN install -d -m 0700 -o node -g node /var/lib/smartsell/media
USER node
WORKDIR /app/apps/server
CMD ["bash", "/app/infra/start.sh"]
