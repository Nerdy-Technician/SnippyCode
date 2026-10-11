FROM node:25-alpine AS server-deps

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:25-alpine AS client-deps

WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --legacy-peer-deps

FROM node:25-alpine AS build

WORKDIR /app
ENV NODE_OPTIONS=--openssl-legacy-provider
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=client-deps /app/client/node_modules ./client/node_modules
COPY . .
RUN npm run build:tsc \
  && npm run build --prefix client \
  && mkdir -p public data \
  && cp -R client/build/. public/

FROM node:25-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Interpreters for server runs, bubblewrap to sandbox them, and linters
RUN apk add --no-cache bash python3 bubblewrap shellcheck ruff

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/public ./public
COPY agent ./agent
RUN mkdir -p data/backups

EXPOSE 5000

CMD ["node", "build/server.js"]
