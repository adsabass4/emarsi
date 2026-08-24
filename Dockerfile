# Build for both linux/amd64 and linux/arm64 (Oracle Ampere, Raspberry Pi).
# Uses Node 24 (LTS) which ships a stable built-in `node:sqlite` module,
# so no native compilation step is required on any architecture.
FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Named volumes in docker-compose inherit these ownerships.
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs

USER node

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]