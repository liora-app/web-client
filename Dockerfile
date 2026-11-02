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

# The spatial island (spatial-island-local/, a standalone Vite app with its own lockfile) is served
# under /island/; ISLAND_BASE makes its asset, font and model URLs absolute to that path.
FROM node:24-alpine AS island
WORKDIR /island
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY spatial-island-local/package.json spatial-island-local/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY spatial-island-local/ ./
RUN ISLAND_BASE=/island/ npm run build

FROM caddy:2
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
COPY --from=island /island/dist /srv/island
EXPOSE 8080
