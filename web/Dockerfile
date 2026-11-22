FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY *.mjs *.css campus-index.html ./
RUN node build-web.mjs /app/compiled-web

FROM node:22-alpine
RUN apk add --no-cache nginx
ARG SOURCE_COMMIT=local
ENV PAPERPLANE_CAMPUS_BUILD_SHA=$SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /app
COPY --from=builder /app/compiled-web ./compiled-web/
COPY fixture/ fixture/
COPY asset-contract.mjs assemble-web.mjs campus-nginx.conf nginx-main.conf entrypoint.sh ./
USER node
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
