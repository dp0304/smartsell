FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/ apps/web/
COPY packages/ packages/
RUN pnpm --filter @smartsell/web... install --frozen-lockfile && pnpm --filter @smartsell/web exec vite build

FROM nginx:1.28-alpine
COPY --from=build /app/apps/web/dist/ /srv/web/
COPY apps/portal/ /srv/portal/
COPY apps/public/index.html /srv/public/index.html
COPY apps/public/assets/ /srv/public/assets/
COPY infra/web.conf /etc/nginx/templates/default.conf.template
COPY infra/web-proxy.conf /etc/nginx/web-proxy.conf
