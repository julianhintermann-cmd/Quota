# Quota – Node-Server mit SQLite-Datenbank (keine weiteren Pakete nötig)
FROM node:22-alpine

RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/monatsbudget-entrypoint
RUN chmod 755 /usr/local/bin/monatsbudget-entrypoint && mkdir -p /data && chown node:node /data

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["monatsbudget-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
