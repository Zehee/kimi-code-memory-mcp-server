---
key: 'no-plaintext-secrets'
title: 'No Plaintext Secrets in Memory'
tags:
  - rule
  - security
  - workflow
createdAt: '2026-06-20T10:10:00.000Z'
updatedAt: '2026-06-20T10:10:00.000Z'
---

# No Plaintext Secrets in Memory

## Rule

Never store API keys, passwords, tokens, or other secrets in `memory/` or `notes/`.

## Scope

Applies to all memories written by agents or edited by users.

## Why

Memories are stored as plain Markdown files and may be committed to git or shared across workspaces.

## Enforcement

- Agents should reject `remember` calls that contain secret-like strings.
- Users should review memories before committing them to version control.

> 来源：memory/rules/no-plaintext-secrets
