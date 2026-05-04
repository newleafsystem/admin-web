# Agentic AI Skills

This document describes reusable AI-agent skills for working on NewLeaf. It is not a runtime plugin manifest; it is a practical guide for splitting and executing work.

## Skill: Codebase Explorer

Use when:

- the prompt asks how something works;
- the implementation area is unknown;
- multiple modules may be involved;
- a safe plan needs current code evidence.

Expected output:

- relevant files and line references;
- current behavior;
- risks and missing pieces;
- suggested edit scope.

Do not edit files in this skill.

## Skill: Backend API Implementer

Use when:

- adding routes;
- adding validation;
- changing repository behavior;
- wiring service methods;
- integrating provider APIs.

Primary files:

- `apps/api/src/app.js`
- `apps/api/src/routes/*`
- `apps/api/src/services/*`
- `apps/api/src/lib/repository.js`
- `apps/api/src/lib/validation.js`

Checklist:

- route has role checks;
- body has explicit validation;
- provider logic is in a service;
- repository changes are narrow;
- errors use `badRequest`, `conflict`, or `notFound`;
- status/progress metadata is persisted for long-running work.

## Skill: Admin UI Implementer

Use when:

- adding or changing admin pages;
- changing navigation;
- adding cards, tables, modals, or controls;
- normalizing API data for UI consumption.

Primary files:

- `apps/admin/src/App.jsx`
- `apps/admin/src/api.js`
- `apps/admin/src/sections/*`
- `apps/admin/src/components/*`
- `apps/admin/src/styles.css`

Checklist:

- UI calls NewLeaf API only;
- API responses are normalized in `api.js`;
- section state stays section-local where possible;
- destructive actions use custom confirmation modals;
- progress is visible for long-running actions;
- text fits in mobile and desktop layouts.

## Skill: Provider Integration Implementer

Use when:

- adding OAuth scopes;
- adding upload, update, delete, or import behavior;
- handling provider polling;
- improving error messages from provider responses.

Checklist:

- verify current official provider docs before changing endpoints;
- refresh tokens server-side;
- validate required scopes;
- persist provider IDs early;
- update progress before and after each long operation;
- preserve provider request/response context where useful;
- handle rate limits and provider processing states.

## Skill: Workflow State Designer

Use when:

- a prompt asks where progress should appear;
- statuses are confusing;
- multiple pages show the same workflow;
- a new job or publishing state is needed.

Checklist:

- define the source of truth;
- define terminal and non-terminal states;
- define valid transitions;
- define admin-facing labels;
- define retry and delete behavior;
- avoid duplicate representations of the same state.

## Skill: Documentation Writer

Use when:

- behavior changes require setup docs;
- provider integration steps change;
- architectural decisions need preservation;
- future agents need operating instructions.

Primary files:

- `AGENTS.md`
- `README.md`
- `docs/*.md`

Checklist:

- document exact route names and environment variables;
- keep examples sanitized;
- link related docs;
- write implementation guidance specific to this repo;
- mention checks and manual verification steps.

## Skill: Verification Agent

Use when:

- another agent is implementing code;
- a change touches API plus UI;
- provider behavior is difficult to test automatically;
- there is a risk of syntax or build regressions.

Checks:

```bash
npm run check
npm run build -w @newleaf/admin
```

Additional review:

- inspect route order for path conflicts;
- inspect UI import/export names;
- inspect normalization defaults;
- inspect provider scope checks;
- inspect progress metadata and retry behavior.

## Multi-Agent Prompt Handling

If a user prompt includes multiple tasks or multiple bullet points, split the work.

Recommended patterns:

- `explorer` reads current code paths while the main agent starts the obvious local edit.
- `worker` handles backend while another worker handles admin UI, if write scopes are disjoint.
- `verifier` runs checks and reviews likely regressions after implementation begins.
- `documentation writer` updates docs in parallel only when implementation details are stable enough.

Examples:

```text
Prompt: Add YouTube import and redesign Published Videos cards.
Agent split:
- explorer: inspect current publishing/publication paths.
- worker 1: backend import endpoint and service.
- worker 2: admin card UI and API client.
- verifier: run check/build and inspect route conflicts.
```

```text
Prompt: Add X, LinkedIn, and Meta upload workers.
Agent split:
- explorer: provider account/token patterns.
- worker 1: X worker.
- worker 2: LinkedIn worker.
- worker 3: Meta/Instagram/Facebook worker.
- verifier: common publisher behavior and build checks.
```

Keep one agent responsible for final integration so parallel work does not produce incompatible abstractions.
