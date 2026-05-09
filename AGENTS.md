# AGENTS.md

Repository-level guide for Codex and other AI coding agents working on NewLeaf System.

## Project Overview

NewLeaf System is an API-first video automation and admin operations platform. It supports content intake, HeyGen video generation, FFmpeg-based video assembly, review, publishing preparation, social publishing, and an admin-facing Video Studio MVP.

Main media flow:

```text
HeyGen clips or screen recordings
-> manifest / timeline JSON
-> validation
-> FFmpeg normalization and rendering
-> final MP4
-> future storage and publishing such as YouTube or Google Cloud Storage
```

The admin UI is an operations console. Keep screens compact, direct, and action-oriented.

## Actual Stack

- Package manager: `npm` with workspaces.
- Runtime: Node.js 20+, ES modules.
- Backend: JavaScript Express API in `apps/api`; not NestJS.
- Frontend: JavaScript React 19 + Vite in `apps/admin`; not Next.js.
- Shared video tooling: `packages/video-assembler`.
- Publisher adapter scaffold: `packages/publishers`.
- Deployment target: Firebase Hosting for the admin UI and Google Cloud Run for API/media services. Cloudflare is no longer an active production runtime target.
- Test style: plain Node scripts and `node --check`; Jest, Vitest, and Mocha are not currently present.
- Local persistence: `.local-data` in development.
- Video rendering: FFmpeg invoked through `child_process`, not a wrapper library.

## Repository Map

```text
apps/api/
  src/app.js                    Express composition root and route mounting
  src/config.js                 environment parsing
  src/lib/repository.js         local repository abstraction
  src/lib/firestoreRepository.js Firestore production repository adapter
  src/routes/                   Express routers
  src/services/                 HeyGen, review, publishing, thumbnails, Video Studio

apps/admin/
  src/App.jsx                   top-level state orchestration and route selection
  src/api.js                    admin API client and response normalization
  src/sections/                 feature sections, including VideoStudio
  src/components/               shared UI components
  src/styles.css                global admin UI styles

packages/video-assembler/
  src/videoAssembler.js         manifest-driven HeyGen clip assembly
  src/videoTimelineRenderer.js  Video Studio timeline rendering with FFmpeg
  src/segmentStatusService.js   HeyGen segment completion mapping/readiness
  src/downloadSegment.js        future download helper

packages/publishers/
  src/                          social publisher adapter interface/scaffold

services/api/
  Dockerfile                    Cloud Run API container build
  cloudbuild.yaml               Cloud Build config for API image

services/media-renderer/
  src/                          Cloud Run FFmpeg renderer
  Dockerfile                    renderer image with FFmpeg installed

scripts/                        CLI utilities and dev server scripts
docs/                           architecture, implementation, API, and media docs
```

## First Reads

Before changing behavior, inspect the nearest relevant files and these docs:

- [README.md](README.md)
- [docs/architecture-flows.md](docs/architecture-flows.md)
- [docs/implementation-patterns.md](docs/implementation-patterns.md)
- [docs/video-assembler.md](docs/video-assembler.md)
- [docs/newleaf-video-studio.md](docs/newleaf-video-studio.md)
- [docs/agentic-ai-workflows.md](docs/agentic-ai-workflows.md)
- [docs/agentic-ai-implementation-checklist.md](docs/agentic-ai-implementation-checklist.md)
- [docs/end-to-end-api-solution.md](docs/end-to-end-api-solution.md)
- [docs/firebase-google-runtime-architecture.md](docs/firebase-google-runtime-architecture.md)
- [docs/social-channel-secrets.md](docs/social-channel-secrets.md)
- [docs/youtube-oauth-flow.md](docs/youtube-oauth-flow.md)

## Companion Agent Guides

- Codex: [AGENTS.md](AGENTS.md)
- Claude Code: [CLAUDE.md](CLAUDE.md)
- Cursor general: [.cursor/rules/newleaf-agent-guide.mdc](.cursor/rules/newleaf-agent-guide.mdc)
- Cursor architecture: [.cursor/rules/newleaf-architecture.mdc](.cursor/rules/newleaf-architecture.mdc)
- Cursor backend: [.cursor/rules/newleaf-backend-patterns.mdc](.cursor/rules/newleaf-backend-patterns.mdc)
- Cursor UI: [.cursor/rules/newleaf-ui-patterns.mdc](.cursor/rules/newleaf-ui-patterns.mdc)
- Cursor workflow: [.cursor/rules/newleaf-agent-workflow.mdc](.cursor/rules/newleaf-agent-workflow.mdc)

## Core Architecture Rules

- Timeline JSON is the source of truth for Video Studio edits.
- Manifest `sequence` is the source of truth for HeyGen multi-clip assembly.
- Never rely on HeyGen completion order, file creation time, download time, folder listing order, or provider video id order.
- Do not mutate original uploaded media when admins trim, cut, mute, add overlays, or render.
- FFmpeg is the backend render/export engine. The frontend edits metadata and preview state.
- Keep frontend preview separate from backend final rendering.
- Keep rendering logic modular, injectable, and testable.
- Admin UI must call NewLeaf APIs only. It must not call HeyGen, YouTube, X, LinkedIn, Meta, TikTok, or OpenAI directly.
- Backend services own provider credentials, OAuth tokens, retries, polling, webhooks, publishing state, and audit metadata.
- Prefer existing route/service/repository patterns over introducing new framework structure.

## Video Pipeline Conventions

- Use sequence numbers such as `10`, `20`, `30` so new segments can be inserted later.
- Normalize final MP4 to 1920x1080, 30fps, H.264/libx264, AAC, yuv420p, and 48kHz audio unless explicit project settings override it.
- Store temporary render files under `temp/{projectId}/` or project-local `temp/` when routed through Video Studio.
- Store final outputs under `output/` or configured storage.
- Keep uploads under allowed upload or project directories.
- Do not overwrite original uploads.
- Validate every timeline or manifest before FFmpeg starts.
- Keep large media as files/streams. Do not load large files into memory unless an existing local endpoint already does so and the scope is clear.
- For Windows FFmpeg `drawtext`, support explicit fonts through `FFMPEG_FONT_FILE`.

## HeyGen Rules

- HeyGen clips may complete in random order.
- Completion callbacks or polling should only update the matching segment by `heygenVideoId`, `projectId`, `sequence`, and `segmentKey`.
- Final stitched order must come from manifest sequence metadata.
- Local development may use deterministic dev provider ids when `HEYGEN_API_KEY` is absent.
- Do not store raw HeyGen credentials or raw secret payloads in manifests, docs, logs, or audit records.

## Backend Patterns

- Routes are Express routers created with `createXRouter(...)`.
- Use `requireRole`, `asyncHandler`, `httpErrors`, and `validation.js` helpers.
- Services are factory functions with injected dependencies.
- Provider-facing code belongs in services, not routes.
- Repository calls go through `apps/api/src/lib/repository.js` unless the feature intentionally uses local project files such as Video Studio.
- Job status transitions should use `jobStateService` when workflow state matters.
- Every provider callback, queue task, publish attempt, retry, import, and delete should be idempotent.
- OAuth `tokenSecretRef` values are opaque repository references. Publisher, sync, import, update, thumbnail, and delete services must call `repository.getSecret(...)` instead of checking storage prefixes such as `dev-memory:` or `firestore-secret:`.

## Admin UI Patterns

- `apps/admin/src/api.js` owns fetch calls and response normalization.
- `App.jsx` owns cross-section state unless a feature is fully section-local.
- `apps/admin/src/sections/*` should keep JSX scoped to the feature.
- Use compact panels, tables, modals, video cards, and progress meters.
- Use custom confirmation modals, not browser `alert`, `confirm`, or `prompt`.
- Avoid showing provider complexity unless it helps an admin decide what to do next.
- Do not build marketing pages or decorative hero layouts inside the operations console.

## Security And Safety Rules

- Never commit or document real API keys, OAuth tokens, HeyGen keys, YouTube tokens, refresh tokens, service credentials, or provider secret payloads.
- Use `.env.example` for environment variable names and placeholders.
- Do not read, paste, summarize, or expose `.env`, `.local-data`, token files, or provider callback payloads unless the user explicitly asks and the content is sanitized.
- Sanitize upload paths and filenames.
- Avoid arbitrary absolute paths from user input.
- Verify resolved paths stay inside the intended project or upload root before reading, writing, deleting, or streaming.
- Build FFmpeg commands with argument arrays, not string-concatenated shell commands.
- Stream large files where practical.
- Fail with clear actionable errors and do not expose secrets in logs.
- Deleted provider videos remain audit records unless the user explicitly asks for hard local deletion.
- Never delete user files or local media unless the user explicitly asks for that operation and the path is verified.

## Coding Style

- Preserve the repo's JavaScript ES module style.
- Prefer small modules and testable functions.
- Avoid overengineering and avoid heavy dependencies without a clear need.
- Add validation before rendering, publishing, uploading, deleting, or provider calls.
- Use structured JSON parsing or APIs instead of ad hoc string manipulation where possible.
- Keep changes focused. Do not rewrite working code unnecessarily.
- Update docs when behavior, setup, environment variables, routes, or provider flows change.

## Testing And Verification

Run the strongest cheap checks available before finishing:

```bash
npm run check
npm test
npm run build -w @newleaf/admin
```

For FFmpeg-heavy changes:

- Add validation tests or command-generation tests where practical.
- Mock or validate inputs when full rendering is slow or unavailable.
- Provide exact manual render commands and required sample files.
- Report whether FFmpeg was actually available in the environment.

## Commands

Install:

```bash
npm install
```

Development:

```bash
npm run dev
npm run dev:start
npm run dev:restart
npm run dev:stop
npm run dev:api
npm run dev:admin
```

Checks and tests:

```bash
npm run check
npm test
npm run build -w @newleaf/admin
```

Video assembly:

```bash
npm run assemble:video -- <path-to-manifest.json>
npm run check:project-ready -- <path-to-manifest.json>
```

Video Studio timeline render:

```bash
npm run render:timeline -- <path-to-timeline.json>
```

Lint:

```bash
npm run lint
```

Note: the root `lint` script exists, but the current workspace package manifests do not define concrete lint scripts.

## NewLeaf Domain And Brand Rules

- Brand: NewLeaf System.
- Visual style: premium fintech, deep forest green, muted gold, clean, calm, risk-aware.
- Avoid hype, casino/trading-guru visuals, guaranteed-profit claims, and aggressive sales language.
- Options/trading content must be educational and risk-aware.
- Prefer phrases such as `model-estimated`, `may act as`, `data-supported`, `defined risk`, and `not guaranteed`.
- Do not say a trade is safe, guaranteed, risk-free, certain, or cannot lose money.
- Include appropriate educational framing for financial content.

## Agent Behavior

- Inspect before editing.
- For larger changes, provide a short implementation plan first.
- Keep changes focused and incremental.
- Do not silently change architecture.
- Do not delete user files or generated media unless explicitly asked.
- Do not modify original uploaded videos unless explicitly asked.
- Prefer patches that fit existing patterns.
- After completing and verifying requested changes, commit and push the agent's own changes with a clear title and description unless the user explicitly says not to commit or push.
- Stage only files or hunks that belong to the current task. Do not include unrelated dirty-worktree changes, generated output, secrets, or user-local files.
- Report what changed, what was committed and pushed, commands run, how to test, and remaining gaps.
- If uncertain, state assumptions clearly.

## Future Roadmap

Mention as future work unless the user explicitly asks to implement:

- draggable timeline UI
- waveform editor
- zoom/pan keyframes
- cursor highlight automation
- subtitles
- YouTube upload after render
- Firebase Storage / Google Cloud Storage
- async render queue
- render progress tracking
- full admin Video Studio
