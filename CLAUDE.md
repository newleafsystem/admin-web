# CLAUDE.md

Project onboarding and working instructions for Claude Code in the NewLeaf System repository.

## Project Context

NewLeaf System is a Node.js video automation and admin editor platform. It supports content intake, HeyGen video generation, manifest-based clip assembly, timeline JSON rendering, FFmpeg export, review workflows, social publishing preparation, and an admin-facing Video Studio MVP.

Core media flow:

```text
HeyGen clips or screen recordings
-> manifest / timeline JSON
-> validation
-> FFmpeg rendering
-> final MP4
-> future storage and YouTube / Google Cloud Storage publishing
```

The admin UI is an operations console, not a marketing site or full nonlinear editor.

## Actual Repo Stack

- Package manager: npm workspaces.
- Language: JavaScript ES modules.
- Backend: Express in `apps/api`; NestJS is not currently present.
- Frontend: React 19 + Vite in `apps/admin`; Next.js is not currently present.
- TypeScript is not currently used in the app code.
- Video tools: `packages/video-assembler`.
- Publisher adapters: `packages/publishers`.
- Tests: plain Node validation scripts plus `node --check`; Jest, Vitest, and Mocha are not currently present.
- Local state: `.local-data` for development.

## Important Files

```text
apps/api/src/app.js
apps/api/src/config.js
apps/api/src/routes/
apps/api/src/services/
apps/admin/src/App.jsx
apps/admin/src/api.js
apps/admin/src/sections/
apps/admin/src/styles.css
packages/video-assembler/src/videoAssembler.js
packages/video-assembler/src/videoTimelineRenderer.js
packages/video-assembler/src/segmentStatusService.js
docs/video-assembler.md
docs/newleaf-video-studio.md
docs/implementation-patterns.md
docs/architecture-flows.md
docs/agentic-ai-workflows.md
docs/agentic-ai-implementation-checklist.md
```

## Companion Agent Guides

- Codex guide: `AGENTS.md`
- Cursor general guide: `.cursor/rules/newleaf-agent-guide.mdc`
- Cursor architecture guide: `.cursor/rules/newleaf-architecture.mdc`
- Cursor backend guide: `.cursor/rules/newleaf-backend-patterns.mdc`
- Cursor UI guide: `.cursor/rules/newleaf-ui-patterns.mdc`
- Cursor workflow guide: `.cursor/rules/newleaf-agent-workflow.mdc`

## Architecture Constraints

- Timeline JSON is the source of truth for Video Studio edits.
- Manifest `sequence` is the source of truth for multi-clip HeyGen assembly.
- HeyGen clips may complete in random order. Completion order must never determine final video order.
- Do not rely on filesystem order, file creation time, download time, or provider id order.
- Do not mutate original uploaded media when trimming, cutting, muting, adding overlays, or rendering.
- FFmpeg is the backend render/export engine. The frontend edits metadata and preview state.
- Keep preview behavior separate from final render behavior.
- Keep rendering modules small, modular, and testable.
- Admin UI calls NewLeaf APIs only. External provider calls belong in backend services.

## Video Pipeline Rules

- Use segment sequence numbers such as `10`, `20`, `30` so new segments can be inserted later.
- Default render output should be 1920x1080, 30fps, H.264/libx264, AAC, yuv420p, and 48kHz audio unless settings override it.
- Store temporary files under `temp/{projectId}/` or project-local `temp/`.
- Store final files under `output/` or configured storage.
- Keep uploads under allowed upload/project directories.
- Never overwrite source uploads.
- Validate timelines/manifests before invoking FFmpeg.
- Use `FFMPEG_FONT_FILE` when Windows FFmpeg needs an explicit drawtext font.

## Security And Safety

- Never commit or display real secrets from `.env`, `.local-data`, OAuth tokens, HeyGen keys, YouTube credentials, provider callback payloads, service account files, or storage credentials.
- Use `.env.example` for public configuration examples.
- Sanitize upload paths and filenames.
- Avoid arbitrary absolute paths from user input.
- Verify resolved paths remain inside the intended root before reading, writing, deleting, or streaming.
- Build FFmpeg commands as argument arrays, not shell strings.
- Stream large files when practical.
- Do not log secrets. Return clear, actionable errors.
- Do not delete user files or generated media unless explicitly asked and path scope is verified.

## Coding Expectations

- Preserve the existing JavaScript ES module style.
- Prefer small modules and testable functions.
- Follow existing Express route/service patterns.
- Treat OAuth `tokenSecretRef` values as opaque repository references; only repository adapters may interpret prefixes such as `dev-memory:` or `firestore-secret:`.
- Keep admin UI feature logic in `apps/admin/src/sections/*` and fetch normalization in `apps/admin/src/api.js`.
- Avoid heavy dependencies unless the need is clear.
- Avoid rewrites of working code.
- Add validation before rendering, publishing, uploading, or deleting.
- Update docs when behavior, setup, routes, environment variables, or provider flows change.

## Commands

Install dependencies:

```bash
npm install
```

Run development servers:

```bash
npm run dev
npm run dev:api
npm run dev:admin
npm run dev:restart
npm run dev:stop
```

Verify:

```bash
npm run check
npm test
npm run build -w @newleaf/admin
```

Video assembler:

```bash
npm run assemble:video -- <path-to-manifest.json>
npm run check:project-ready -- <path-to-manifest.json>
```

Video Studio render:

```bash
npm run render:timeline -- <path-to-timeline.json>
```

Lint note:

```bash
npm run lint
```

The root lint script exists, but concrete workspace lint scripts are not currently present.

## Testing Expectations

- Run existing tests when practical.
- For timeline and manifest work, add or update validation tests under `packages/video-assembler/src/*.validation.test.js`.
- For API work, use the existing plain Node route/service test style.
- For FFmpeg-heavy changes, provide manual verification commands if full render cannot run in the current environment.
- Always report commands run and whether FFmpeg was available.

## NewLeaf Brand And Compliance

- Brand: NewLeaf System.
- Style: premium fintech, deep forest green, muted gold, clean, calm, risk-aware.
- Avoid hype, casino/trading-guru visuals, guaranteed-profit claims, and aggressive sales language.
- Options/trading content must be educational and risk-aware.
- Prefer `model-estimated`, `may act as`, `data-supported`, `defined risk`, and `not guaranteed`.
- Do not describe trades as safe, guaranteed, risk-free, certain, or unable to lose.

## Safe Change Behavior

- Inspect relevant files before editing.
- For larger changes, present a short plan first.
- Keep changes focused.
- Do not silently change architecture.
- Do not modify original uploaded media unless explicitly asked.
- Do not delete files unless explicitly asked and verified.
- At completion, report files changed, checks run, how to test, setup/restart needs, and remaining gaps.

## Future Roadmap

Mention as roadmap unless explicitly asked to implement:

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
