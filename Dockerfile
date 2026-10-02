FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/omnitext.db \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The SQLite database lives here; mount a volume so it survives redeploys.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
