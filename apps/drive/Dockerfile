# syntax=docker/dockerfile:1
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/drive/package.json apps/drive/
COPY apps/drive/prisma apps/drive/prisma
COPY apps/drive/prisma.config.ts apps/drive/
COPY packages/contracts/package.json packages/contracts/
COPY packages/typescript-config/package.json packages/typescript-config/
RUN pnpm install --frozen-lockfile --prod --filter @opensuite/drive...
COPY apps/drive/src apps/drive/src
COPY packages/contracts/src packages/contracts/src
ENV NODE_ENV=production
USER 999:999
EXPOSE 3001
CMD ["node", "apps/drive/src/main.ts"]
