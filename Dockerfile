FROM node:26.5.0-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS build
WORKDIR /app
COPY package.json ./
COPY scripts/prepare-checked-pnpm.mjs ./scripts/prepare-checked-pnpm.mjs
RUN node scripts/prepare-checked-pnpm.mjs
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm check:install-state
RUN pnpm security:build-toolchain
RUN pnpm security:dependencies
RUN pnpm rebuild @roamhq/wrtc esbuild
RUN pnpm security:build-toolchain
RUN pnpm security:dependencies
RUN pnpm build
RUN pnpm prune --prod
RUN rm -rf \
  node_modules/@roamhq \
  node_modules/domexception \
  node_modules/webidl-conversions \
  node_modules/.pnpm/@roamhq+wrtc@* \
  node_modules/.pnpm/@roamhq+wrtc-*@* \
  node_modules/.pnpm/domexception@* \
  node_modules/.pnpm/webidl-conversions@*

FROM node:26.5.0-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c
WORKDIR /app
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="p2p-transfer" \
  org.opencontainers.image.description="End-to-end encrypted WebRTC file transfer signaling server" \
  org.opencontainers.image.source="https://github.com/VictorHaine/p2p-transfer" \
  org.opencontainers.image.url="https://github.com/VictorHaine/p2p-transfer" \
  org.opencontainers.image.documentation="https://github.com/VictorHaine/p2p-transfer#readme" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version=$VERSION \
  org.opencontainers.image.revision=$REVISION
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
COPY --chown=node:node --from=build /app/LICENSE /app/README.md /app/SECURITY.md ./
COPY --chown=node:node --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist-node/server ./dist-node/server
COPY --chown=node:node --from=build /app/dist-node/shared ./dist-node/shared
COPY --chown=node:node --from=build /app/dist-web ./dist-web
COPY --chown=node:node --from=build /app/scripts/probe-http.mjs ./scripts/probe-http.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD PROBE_URL=http://127.0.0.1:${PORT:-8787}/healthz PROBE_STATUS=200 node scripts/probe-http.mjs
CMD ["node", "dist-node/server/index.js"]
