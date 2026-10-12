# ADR-0004: Node for hooks and scripts, with strict quality gates

- Status: accepted
- Date: 2026-10-12

## Context

Hooks parse JSON on stdin and must behave the same on macOS, Linux and Windows.
Both harnesses already require Node-compatible environments in practice, and the
reference plugin (ponytail) uses Node hooks.

## Decision

- Hooks and scripts are ESM `.mjs` on Node ≥22.8 with zero runtime dependencies.
- Tests use `node:test`; coverage uses Node's built-in coverage with ≥98% lines,
  branches and functions.
- Biome lints and formats JS/JSON; markdownlint-cli2 lints Markdown.

## Consequences

- No bash/jq portability issues; no runtime install step.
- Logic sits in exported pure functions behind thin `main` entry points so the
  coverage threshold measures real behaviour.
