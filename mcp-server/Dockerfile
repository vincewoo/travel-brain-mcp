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

USER node
EXPOSE 8080
CMD ["node", "src/bootstrap.mjs"]
