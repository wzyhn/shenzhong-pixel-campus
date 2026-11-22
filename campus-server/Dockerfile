ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
ARG SOURCE_COMMIT=local
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs store.mjs progress.mjs album.mjs migrate.mjs presence.mjs chat.mjs clues.mjs name-eggs.mjs nickname-limits.mjs ./
COPY migrations/ migrations/
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
