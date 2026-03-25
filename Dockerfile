FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock index.ts ./
RUN bun install --frozen-lockfile
CMD ["bun", "index.ts"]