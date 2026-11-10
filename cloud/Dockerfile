# Persome Cloud. Node 24 runs the .ts sources directly via native type stripping (no build
# step). One runtime dependency (nodemailer, pinned in package-lock.json) for outgoing mail.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=8787 \
    CLOUD_HOST=0.0.0.0 \
    CLOUD_DB_PATH=/data/cloud.db \
    CLOUD_AUDIO_DIR=/data/audio

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

# DB lives on a volume owned by the unprivileged built-in `node` user (uid 1000).
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]

USER node
EXPOSE 8787

# CLOUD_PUBLIC_ORIGIN must be set at run time to the exact public origin clients
# use (it is the signature audience), e.g. -e CLOUD_PUBLIC_ORIGIN=https://cloud.example.com
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
