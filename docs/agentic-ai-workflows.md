# Agentic AI Workflows

This document describes how AI coding agents should work on the NewLeaf System repository.

NewLeaf is an API-first video automation and admin operations platform. The current repo uses JavaScript ES modules, npm workspaces, Express in `apps/api`, React/Vite in `apps/admin`, and FFmpeg utilities in `packages/video-assembler`.

## Core Working Loop

Use this loop for most tasks:

1. Inspect the relevant files and docs.
2. Identify the actual stack and current implementation.
3. Produce a short plan for large or risky changes.
4. Make small, focused edits.
5. Validate with existing commands or targeted manual checks.
6. Report changed files, checks run, setup needs, and remaining gaps.

Do not change application logic during docs-only tasks.

## Source Of Truth Rules

- Timeline JSON is the source of truth for Video Studio edits.
- Manifest sequence numbers are the source of truth for HeyGen clip assembly.
- HeyGen completion order is random and must not determine final video order.
- Do not rely on filesystem listing order, file creation time, download time, provider id order, or array insertion order for final video order.
- FFmpeg renders from validated metadata and source files.
- Original uploaded media must not be modified by edit or render workflows.

## Multi-Agent Splits

When the tool environment supports multiple agents and the prompt has independent workstreams, split work like this:

- `explorer`: read-only discovery, API mapping, risk analysis.
- `worker`: bounded implementation in clearly owned files.
- `verifier`: independent checks, build/test runs, and regression review.

Good split examples:

- backend endpoint plus admin UI change;
- provider adapter plus docs plus verification;
- video assembler change plus sample manifest plus CLI check;
- service API security plus Swagger/OpenAPI docs;
- audit review plus implementation checklist.

Do not delegate the immediate blocking step if the local next action depends on it.

## Backend Workflow

Use this flow for `apps/api` and backend service changes:

1. Inspect `apps/api/src/app.js`, the relevant router, the related service, `apps/api/src/config.js`, and repository helpers.
2. Keep route handlers thin.
3. Put provider, rendering, publishing, token, and retry logic in services.
4. Validate input before side effects.
5. Preserve idempotency for provider callbacks, retries, deletes, imports, and publish attempts.
6. Update `.env.example` and docs when adding config.
7. Add or update tests if the touched area has test coverage.

## Admin UI Workflow

Use this flow for `apps/admin` changes:

1. Inspect `apps/admin/src/App.jsx`, `apps/admin/src/api.js`, the relevant section, shared components, and `apps/admin/src/styles.css`.
2. Keep API calls in `api.js`.
3. Keep section-specific JSX in `apps/admin/src/sections/*`.
4. Use compact operations-console layouts.
5. Use custom modals for confirmations.
6. Avoid showing provider complexity unless it helps admins act.
7. Ensure desktop and mobile text does not overlap or overflow.

## Video Assembly Workflow

Use this flow for HeyGen segment assembly:

1. Inspect `packages/video-assembler/src/videoAssembler.js`.
2. Validate manifest structure before FFmpeg.
3. Reject duplicate sequences and duplicate segment keys.
4. Require completed status and local files for required segments.
5. Sort by numeric sequence.
6. Normalize every clip before concatenation.
7. Store temp files under `temp/{projectId}/`.
8. Report clear FFmpeg errors.

Expected command:

```bash
npm run assemble:video -- <path-to-manifest.json>
```

## Video Studio Workflow

Use this flow for screen recording and timeline rendering:

1. Inspect `packages/video-assembler/src/videoTimelineRenderer.js`.
2. Inspect `apps/api/src/services/videoStudioService.js` and `apps/api/src/routes/videoProjects.js` for API behavior.
3. Treat timeline JSON as source of truth.
4. Validate source paths, trim ranges, avatar settings, callouts, canvas, and output path.
5. Render to a new output file without modifying uploads.
6. Keep UI controls simple unless the user explicitly asks for a full editor.

Expected command:

```bash
npm run render:timeline -- <path-to-timeline.json>
```

## Provider And Publishing Workflow

Use this flow for social providers:

1. Validate connected account scopes and token health.
2. Refresh OAuth tokens server-side.
3. Store provider ids as early as possible.
4. Update publish-attempt progress and audit metadata.
5. Do not duplicate public posts unless the admin explicitly creates a new publish intent.
6. Preserve deleted and archived records as audit history.
7. Keep platform-specific behavior inside provider services or adapters.

## Security Workflow

Before finishing, check:

- no real secrets were added to docs or code;
- `.env.example` contains placeholders only;
- upload paths and filenames are sanitized;
- arbitrary absolute paths from user input are blocked;
- FFmpeg args are built safely;
- large files are streamed when practical;
- errors are actionable and do not expose secrets.

## Verification Commands

Use commands that exist in the root `package.json`:

```bash
npm run check
npm test
npm run build -w @newleaf/admin
npm run assemble:video -- <path-to-manifest.json>
npm run check:project-ready -- <path-to-manifest.json>
npm run render:timeline -- <path-to-timeline.json>
```

For documentation-only work, file existence and content verification is usually enough.

## Tool-Specific Guides

- Codex: `AGENTS.md`
- Claude Code: `CLAUDE.md`
- Cursor: `.cursor/rules/*.mdc` and `.cursorrules`

Keep these guides consistent when architecture or workflow rules change.
