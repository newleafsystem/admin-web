# Agentic AI Implementation Checklist

Use this checklist before, during, and after AI-assisted changes in the NewLeaf repository.

## 1. Pre-Change Inspection

- [ ] Read the user request carefully.
- [ ] Inspect the nearest relevant source files.
- [ ] Inspect existing docs for the touched area.
- [ ] Identify the actual stack before proposing changes.
- [ ] Check whether the work is docs-only, backend, admin UI, video rendering, provider integration, or verification.
- [ ] For large changes, write a short plan before editing.

## 2. Architecture Guardrails

- [ ] Timeline JSON remains the source of truth for Video Studio edits.
- [ ] Manifest sequence remains the source of truth for HeyGen clip assembly.
- [ ] HeyGen completion order is not used for final video order.
- [ ] Filesystem listing order is not used for final video order.
- [ ] Original uploaded media is not mutated.
- [ ] FFmpeg remains the backend render/export engine.
- [ ] Frontend preview remains separate from final backend rendering.

## 3. Backend Checklist

- [ ] Routes remain thin Express routers.
- [ ] Provider and workflow logic lives in services.
- [ ] Inputs are validated before side effects.
- [ ] Repository access goes through existing repository/local data patterns.
- [ ] Job state transitions use existing services when status transitions matter.
- [ ] Provider callbacks, retries, deletes, imports, and publish attempts are idempotent.
- [ ] `.env.example` and docs are updated when config changes.

## 4. Admin UI Checklist

- [ ] API calls are in `apps/admin/src/api.js`.
- [ ] Feature UI is scoped to `apps/admin/src/sections/*`.
- [ ] Confirmation uses custom modals, not browser prompts.
- [ ] UI stays compact and operations-focused.
- [ ] Text does not overlap or overflow in tables, buttons, cards, or modals.
- [ ] Provider complexity is hidden unless it helps admin action.
- [ ] NewLeaf brand colors and risk-aware tone are preserved.

## 5. Video And FFmpeg Checklist

- [ ] Manifest or timeline is validated before FFmpeg runs.
- [ ] Paths are resolved and kept inside allowed roots.
- [ ] Temp files stay under `temp/{projectId}/`.
- [ ] Outputs are written to `output/` or configured local data storage.
- [ ] Source uploads are never overwritten.
- [ ] Final output defaults to 1920x1080, 30fps, H.264/libx264, AAC, yuv420p, 48kHz audio unless settings override it.
- [ ] FFmpeg commands are built as argument arrays, not shell strings.
- [ ] FFmpeg errors are surfaced clearly.

## 6. HeyGen Checklist

- [ ] HeyGen API key is read from environment only.
- [ ] No HeyGen secrets or raw sensitive payloads are logged.
- [ ] Segment mapping can identify `projectId`, `sequence`, `segmentKey`, and `heygenVideoId`.
- [ ] Completion updates status and source URL for the correct segment.
- [ ] Project readiness requires all required segments to complete.
- [ ] Random completion order does not change final sequence.

## 7. Publishing Checklist

- [ ] Connected account scopes and token health are validated.
- [ ] OAuth refresh happens server-side.
- [ ] Provider ids are stored as soon as available.
- [ ] Publish progress and errors are recorded.
- [ ] Duplicate public posts are not created accidentally.
- [ ] Delete/update actions preserve audit history.
- [ ] Deleted and archived records are excluded from active operational queues where appropriate.

## 8. Security Checklist

- [ ] No real API keys, OAuth tokens, service credentials, or provider secrets are committed.
- [ ] `.env.example` uses placeholders only.
- [ ] Upload filenames are sanitized.
- [ ] Arbitrary absolute paths from user input are rejected.
- [ ] Large files are streamed when practical.
- [ ] Logs and error responses do not expose secrets.
- [ ] Destructive file operations verify resolved target paths first.

## 9. Verification Checklist

- [ ] Run targeted syntax checks or tests for touched code when practical.
- [ ] Run `npm run check` for broader code changes when practical.
- [ ] Run `npm run build -w @newleaf/admin` for admin UI changes.
- [ ] Run video render or assembly commands only when safe and useful.
- [ ] If FFmpeg is required but unavailable, provide exact manual commands.
- [ ] For docs-only tasks, verify file existence and key content.

## 10. Final Response Checklist

- [ ] Summarize what changed.
- [ ] List the most important files.
- [ ] State checks run and results.
- [ ] Mention setup or restart needed.
- [ ] Call out remaining risks, limitations, or provider-side blockers.
- [ ] Keep the final answer concise.

## 11. Do Not Implement Unless Asked

- [ ] draggable timeline UI
- [ ] waveform editor
- [ ] zoom/pan keyframes
- [ ] cursor highlight automation
- [ ] subtitles
- [ ] YouTube upload after render
- [ ] Firebase Storage / Google Cloud Storage
- [ ] async render queue
- [ ] render progress tracking
- [ ] full nonlinear video editor
