FROM node:22.18.0-bookworm-slim AS dashboard

WORKDIR /dashboard
COPY ui/travel-dashboard/package.json ui/travel-dashboard/package-lock.json ./
RUN npm ci
COPY ui/travel-dashboard/mcp-app.html ui/travel-dashboard/tsconfig.json ui/travel-dashboard/vite.config.ts ./
COPY ui/travel-dashboard/src ./src
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
COPY --from=dashboard --chown=node:node /dashboard/dist/mcp-app.html ./dashboard/mcp-app.html

USER node
EXPOSE 8080
CMD ["node", "src/bootstrap.mjs"]
