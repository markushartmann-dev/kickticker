FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Build-Tools nur falls better-sqlite3 kein Prebuild fuer die Plattform hat
COPY package.json package-lock.json* ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# Icons zur Sicherheit (neu) erzeugen
RUN node scripts/make-icons.js

ENV PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
