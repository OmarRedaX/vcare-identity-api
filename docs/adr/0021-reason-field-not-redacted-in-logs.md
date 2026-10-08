---
title: "ADR 0021: `reason` is not a redaction key; free-text reasons are never logged"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-07
diataxis: explanation
last_verified: 2026-10-07
tags: [adr, decision, logging, privacy, redaction]
related: [users-tasks, users-spec]
---

# ADR 0021 — `reason` is not a redaction key; free-text reasons are never logged

- **Status:** Accepted • **Date:** 2026-10-07 • **Deciders:** identity-team

## Context

The `users` module accepts a free-text `reason` on admin status changes and stores it in
`user_status_changes.reason`. Free text can carry PII, so adding `reason` to the logger's redaction keys was
considered. About a dozen existing log lines use `reason` as a safe, enum-valued cause (for example a refusal
cause), and redacting the key would hide them and break their tests.

## Decision

Do **not** add `reason` to the redaction keys. Free-text reasons are never passed to the logger: they live in the
database only. New log lines use the field name `cause` for enum-valued causes. Existing `reason` log fields are
left as they are.

## Consequences

- Existing logs and tests keep working; no churn in the auth module.
- Safety depends on discipline, not on the redactor: a developer who logs a free-text `reason` would leak it.
  Review checks for this under "Privacy and logging" in CLAUDE.md.
- Revisit if a second free-text field appears, or rename the existing `reason` log fields to `cause` and then
  redact `reason`.
