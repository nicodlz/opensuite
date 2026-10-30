# syntax=docker/dockerfile:1
# Build context: repository root (`docker build -f apps/api/Dockerfile .`).
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS install
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/jmap/package.json packages/jmap/
COPY packages/db/prisma packages/db/prisma
COPY packages/typescript-config/package.json packages/typescript-config/
RUN pnpm install --frozen-lockfile --prod --filter @opensuite/api...
COPY apps/api/src apps/api/src
COPY packages/contracts/src packages/contracts/src
COPY packages/core/src packages/core/src
COPY packages/jmap/src packages/jmap/src
COPY packages/db/src packages/db/src
COPY scripts/reset-mfa.mjs scripts/reset-mfa.mjs
COPY packages/jmap/src packages/jmap/src

FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install --chown=root:root /app /app
USER node
EXPOSE 3000
# Node runs the TypeScript sources directly (type stripping, Node >= 22.18).
CMD ["node", "apps/api/src/main.ts"]
