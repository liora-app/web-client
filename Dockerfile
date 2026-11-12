# The landing as a static site (ADR-006). Built ON THE HOST by devops/deploy/deploy.sh
# (`docker compose up -d --build web-client`); the edge Caddy proxies `/` here, `/api/*` goes to server.

FROM node:24-alpine AS build
WORKDIR /app
# @playwright/test is a devDependency for the type-checked tests; no browsers are needed here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM caddy:2
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 8080
