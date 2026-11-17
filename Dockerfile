FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-reportlab fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY index.html config.json ./
COPY css ./css
COPY js ./js
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8080 SQLITE_PATH=/data/sprt.sqlite
EXPOSE 8080
CMD ["node", "server/main.mjs"]
