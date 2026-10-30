# Documentation

Start with the [project overview](../README.md). Guides describe the current checkout and its integration limitations.

## Use and administer

- [User guide](user/index.md): accounts, mail and Drive.
- [Administrator guide](admin/index.md): setup, users, domains, outbound mail and suspension.
- [Development and local installation](development.md): Compose, bootstrap, testing and service configuration.
- [Web client](../apps/web/README.md) and [database package](../packages/db/README.md).

## Operations and deployment

- [Production deployment runbook](deployment/production.md): ordered single-server installation and recovery.
- [AWS mail infrastructure](deployment/aws.md): candidate infrastructure and offline validation.
- [Domains](operations/domains.md), [outbound mail](operations/outbound.md), [mail object storage](operations/object-storage.md), [backup and recovery](operations/backup.md), and [observability](operations/observability.md).

## Architecture and decisions

- [Component and security overview](architecture/overview.md); [Pass threat model and alias design](architecture/pass.md).
- [Inbound ingestion](architecture/ingestion.md), [JMAP behaviour](architecture/jmap-behaviour.md), [provider boundaries](architecture/providers.md), and [Stalwart integration evidence](architecture/stalwart.md).
- [ADR 0001: mail engine, identity and reliability](adr/0001-architecture.md); [ADR 0002: single-server production target](adr/0002-production-target.md); [ADR 0003: Esuno Pass](adr/0003-pass.md). These are dated decisions and proof gates, not a live feature checklist.
- [Risks and open questions](risks.md).

For code contributions, see [CONTRIBUTING.md](../CONTRIBUTING.md); release notes are in [CHANGELOG.md](../CHANGELOG.md).
