FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends libsdl2-2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY server.js ./

ENV PORT=5459
EXPOSE 5459

CMD ["npm", "run", "serve"]
