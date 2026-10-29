# syntax=docker/dockerfile:1
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/core/package.json packages/core/
COPY packages/contracts/package.json packages/contracts/
COPY packages/typescript-config/package.json packages/typescript-config/
RUN pnpm install --frozen-lockfile --prod --filter @opensuite/db...
COPY packages/db/src packages/db/src
USER 999:999
WORKDIR /app/packages/db
CMD ["node", "src/migrate.ts"]
