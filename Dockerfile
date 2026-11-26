# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifests and install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Copy source and build the frontend
COPY . .
RUN pnpm run build

# Prune dev dependencies for the runtime image
RUN pnpm prune --prod

EXPOSE 3000
ENV PORT=3000
CMD ["pnpm", "start"]