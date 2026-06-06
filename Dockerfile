FROM node:22.22.3-bookworm-slim@sha256:6ed70fbf60557fb3a2faea5657d4105bace34c93449c2571919a1589fae30153 AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check:install-state
RUN pnpm build
RUN pnpm prune --prod

FROM node:22.22.3-bookworm-slim@sha256:6ed70fbf60557fb3a2faea5657d4105bace34c93449c2571919a1589fae30153
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
COPY --chown=node:node --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist-node ./dist-node
COPY --chown=node:node --from=build /app/dist-web ./dist-web
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist-node/server/index.js"]
