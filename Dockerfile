FROM node:22-bookworm AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/jeopardy.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY *.csv *.sources.json ./
COPY images ./images
COPY LICENSE README.md ./

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "Promise.all([process.env.DISPLAY_PORT || 3001, process.env.ADMIN_PORT || 4001].map(port => fetch('http://127.0.0.1:' + port + '/health').then(res => { if (!res.ok) throw new Error('Unhealthy'); }))).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
