# Both front-end stages reproduce the repository layout on purpose: each imports files by relative
# path from outside its own project — `ui/shared` for the design language and the formatters, and
# for the companion also the server's `src/trip-clock.mjs`, so that its day grouping and the read
# models' cannot drift apart. Flattening these directories would break those imports.
FROM node:22.18.0-bookworm-slim AS dashboard

WORKDIR /build/ui/travel-dashboard
COPY ui/travel-dashboard/package.json ui/travel-dashboard/package-lock.json ./
RUN npm ci
COPY ui/travel-dashboard/mcp-app.html ui/travel-dashboard/tsconfig.json ui/travel-dashboard/vite.config.ts ./
COPY ui/travel-dashboard/src ./src
COPY ui/shared /build/ui/shared
RUN npm run build

FROM node:22.18.0-bookworm-slim AS companion

WORKDIR /build/ui/travel-companion
COPY ui/travel-companion/package.json ui/travel-companion/package-lock.json ./
RUN npm ci
COPY ui/travel-companion/index.html ui/travel-companion/tsconfig.json ui/travel-companion/vite.config.ts ./
COPY ui/travel-companion/public ./public
COPY ui/travel-companion/src ./src
COPY ui/shared /build/ui/shared
COPY src/trip-clock.mjs src/trip-clock.d.mts /build/src/
RUN npm run build

FROM node:22.18.0-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --from=dashboard --chown=node:node /build/ui/travel-dashboard/dist/mcp-app.html ./dashboard/mcp-app.html
COPY --from=companion --chown=node:node /build/ui/travel-companion/dist ./companion

USER node
EXPOSE 8080
CMD ["node", "src/bootstrap.mjs"]
