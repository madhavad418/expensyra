# SpendOps — production image (Railway or any Docker host).
#
# Data lives in Postgres (DATABASE_URL). The image contains code only: no
# local database, backups, receipts, Pleo exports or .env are ever copied
# (see .dockerignore / .railwayignore). A fresh Postgres gets its schema on
# first start and is then filled by Pleo syncs run from the deployed app.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    ATTACHMENT_DIR=/tmp/spendops-attachments

WORKDIR /app

# Dependencies first so they cache between code-only deploys.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY sample ./sample

# /data is only used by the optional docker-compose SQLite setup (volume mount).
RUN mkdir -p /tmp/spendops-attachments /data && chown -R node:node /app /tmp/spendops-attachments /data
USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
