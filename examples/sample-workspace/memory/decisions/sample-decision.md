---
key: 'choose-sqlite-cache'
title: 'Choose SQLite for Cache Layer'
tags:
  - decision
  - database
  - cache
createdAt: '2026-06-20T10:00:00.000Z'
updatedAt: '2026-06-20T10:00:00.000Z'
---

# Choose SQLite for Cache Layer

## Decision

Use SQLite as the local cache layer instead of Redis or an in-memory store.

## Rationale

- **Single-file deployment**: no separate service to run.
- **Sufficient for read-heavy workloads**: cache hits are mostly reads.
- **Familiar tooling**: most developers already know SQL.
- **No network latency**: local file access is fast enough for this scale.

## Consequences

- Write-heavy bursts may become a bottleneck; monitor cache invalidation patterns.
- Backup strategy must include the SQLite file.

> 来源：memory/decisions/choose-sqlite-cache
