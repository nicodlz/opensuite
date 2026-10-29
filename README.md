# OpenSuite

A self-hostable suite for mail, calendar, contacts and file storage.

> **Status: early development.** Only the API skeleton described below exists.
> Mail, calendar, contacts, drive, the web client and the Docker Compose
> installation are planned and not implemented yet.

## What works today

- `apps/api`: a Fastify server hosting typed procedures (oRPC, Zod contracts
  in `packages/contracts`) with structured JSON logs (pino).
  - `GET /health`: liveness; answers `200` while the process runs.
  - `GET /ready`: readiness over the declared backing services; `200` when all
    are up, `503` with per-dependency status otherwise. No backing service is
    declared yet, so it currently always reports ready.
  - `GET /openapi.json`: OpenAPI 3.1 document generated from the contracts.

## Development

Requirements: Node.js 22.18 or later, pnpm 12.

```sh
pnpm install
cp deploy/env.example .env   # optional; defaults match the template
pnpm --filter @opensuite/api dev
curl http://127.0.0.1:3000/health
```

Checks:

```sh
pnpm typecheck
pnpm lint          # oxlint, type-aware
pnpm format:check  # Prettier
pnpm knip          # unused files, exports and dependencies
pnpm test          # Vitest unit project
```

Vitest projects are selected by file suffix: `*.test.ts` runs in `unit`;
`*.db.test.ts`, `*.http.test.ts`, `*.stalwart.test.ts`, `*.ingest.test.ts`
and `*.drive.test.ts` run in the projects of the same name, which need the
corresponding infrastructure.

## Repository layout

| Path                         | Contents                                    |
| ---------------------------- | ------------------------------------------- |
| `apps/api`                   | HTTP API server                             |
| `apps/web`                   | Web client (placeholder)                    |
| `apps/ingest`                | Inbound mail ingestion worker (placeholder) |
| `apps/drive`                 | File storage service (placeholder)          |
| `packages/contracts`         | Shared API schemas and procedure contracts  |
| `packages/core`              | Services (currently readiness evaluation)   |
| `packages/jmap`              | JMAP client (protocol constants only)       |
| `packages/db`                | Database access (placeholder)               |
| `packages/design-tokens`     | Design tokens (placeholder)                 |
| `packages/typescript-config` | Shared strict TypeScript configuration      |
| `packages/oxlint-config`     | Shared oxlint configuration                 |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
