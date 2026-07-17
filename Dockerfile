FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# --omit=optional skips better-sqlite3 (native build, only needed for the
# one-time local SQLite import — the code handles its absence).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY server.js ./
COPY src ./src
COPY public ./public

ENV PORT=3008
EXPOSE 3008

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3008/api/health || exit 1

CMD ["node", "server.js"]
