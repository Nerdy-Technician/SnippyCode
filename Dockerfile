FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS server-deps

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS client-deps

WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --legacy-peer-deps

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build

WORKDIR /app
ENV NODE_OPTIONS=--openssl-legacy-provider
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=client-deps /app/client/node_modules ./client/node_modules
COPY . .
RUN npm run build:tsc \
  && npm run build --prefix client \
  && mkdir -p public data \
  && cp -R client/build/. public/

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Interpreters for server runs, bubblewrap to sandbox them, and linters
RUN apk upgrade --no-cache && apk add --no-cache bash python3 bubblewrap shellcheck ruff

COPY package*.json ./
# npm is only needed to install; dropping it keeps its bundled dependencies
# (and their CVEs) out of the runtime image. Use `node build/backupCli.js`
# for backups inside the container.
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm

COPY --from=build /app/build ./build
COPY --from=build /app/public ./public
COPY agent ./agent
# In-app help pages and the example runbook
COPY docs ./docs
# Run as the image's unprivileged `node` user (uid 1000). It owns only the
# data dir (database-independent files and backups); the app itself is
# read-only to it. Existing root-owned volumes need a one-off chown, see
# docs/upgrading-v1.2.3.md.
RUN mkdir -p data/backups && chown -R node:node data
USER node

EXPOSE 5000

CMD ["node", "build/server.js"]
