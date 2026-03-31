### Stage 1: Build ###
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm config set registry https://registry.npmjs.org/

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --network-timeout 10000

COPY src/ ./src/
COPY tsconfig.json ./
RUN pnpm run build

### Stage 2: Runtime ###
FROM node:20-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm config set registry https://registry.npmjs.org/

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --network-timeout 10000

COPY --from=builder /app/dist ./dist/

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
