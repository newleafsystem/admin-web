# Video Assembler

The video assembler creates one final MP4 from smaller HeyGen-generated clips or manually prepared clip files.

The key rule is strict: final video order comes only from the project manifest `sequence` values. Do not use file creation time, download time, webhook completion order, or folder listing order.

## Where It Fits

Use the assembler after all required HeyGen segment videos have reached `completed`, or after an admin has uploaded replacement/manual clips for the same segment timeline.

Recommended product flow:

1. A script or scene planner creates a manifest with stable `sequence`, `segmentKey`, and `heygenVideoId` values.
2. `POST /api/v1/jobs/:jobId/generate-video` creates one HeyGen provider job per manifest segment.
3. HeyGen clips complete in any order through webhook or polling.
4. Each completed clip is downloaded or copied into a sequence-aware local path, for example `input/20-market-context.mp4`.
5. The assembler validates all required clips and stitches them in manifest order.
6. The final MP4 becomes the job's `currentVideoArtifactId` for review and later publishing.

This means a completion order of `40, 10, 30, 20, 50` still produces `10, 20, 30, 40, 50`.

## HeyGen Completion Stub

HeyGen segment completion is asynchronous, and clips may finish in any order. The first integration point is intentionally a local manifest update service, not a live HeyGen API client.

`SegmentStatusService` maps a completed `heygenVideoId` back to:

- `projectId`;
- `sequence`;
- `segmentKey`;
- manifest path;
- segment metadata.

Use `updateSegmentCompletion(projectId, heygenVideoId, completedVideoUrl)` when a webhook or poller receives a completed HeyGen clip URL. It updates only the matching manifest segment:

```json
{
  "status": "completed",
  "sourceUrl": "https://provider.example/video.mp4"
}
```

The completion event order is not trusted. The assembler still sorts by manifest `sequence`.

Future live HeyGen polling/downloading should only run when credentials are configured through environment variables. Do not put credentials in manifests or repository files.

Future variables:

```env
HEYGEN_API_KEY=
HEYGEN_API_BASE_URL=https://api.heygen.com
HEYGEN_CALLBACK_URL=
VIDEO_STORAGE_DIR=
FFMPEG_PATH=
FFPROBE_PATH=
```

`VIDEO_STORAGE_DIR` may point to a subdirectory under `LOCAL_DATA_DIR`. If it is absolute and outside `LOCAL_DATA_DIR`, the API falls back to `LOCAL_DATA_DIR/video-assembler` so local-disk artifact paths remain streamable through NewLeaf asset routes.

Current backend wiring:

- If `HEYGEN_API_KEY` is configured, NewLeaf requests segment videos through HeyGen Video Agent.
- If `HEYGEN_API_KEY` is not configured, NewLeaf creates deterministic development `heygenVideoId` values and waits for manual/dev completion.
- If `HEYGEN_CALLBACK_URL` is configured, NewLeaf sends it as the Video Agent `callback_url`. For local development, leave it empty and use polling unless you expose the local API through a tunnel.
- HeyGen webhook success calls the same segment completion path as polling.
- Polling can be triggered for a provider job with `POST /api/v1/jobs/:jobId/provider-jobs/:providerJobId/poll`.
- Local development can complete a segment without HeyGen by posting a local file path or file URL to `POST /api/v1/jobs/:jobId/video-assembly/segments/:heygenVideoId/complete`.
- The admin UI can upload a completed clip directly to `POST /api/v1/jobs/:jobId/video-assembly/segments/:heygenVideoId/upload`. The backend writes the bytes into the manifest segment path, marks only that segment completed, and stitches when all required segments are completed.

Development completion body:

```json
{
  "sourceUrl": "C:/absolute/path/to/completed-segment.mp4"
}
```

or:

```json
{
  "completedVideoUrl": "file:///C:/absolute/path/to/completed-segment.mp4"
}
```

When the last required segment completes, the backend runs FFmpeg assembly, stores the final video as a local `video` artifact, and attempts a best-effort FFmpeg thumbnail snapshot. If FFmpeg is unavailable or the snapshot fails, video generation still completes without a thumbnail.

## Admin Hybrid Flow

The Create Content screen supports a segmented/hybrid intake mode for local testing:

1. Add timeline segments with explicit `sequence` and `segmentKey` values.
2. Add a prompt for HeyGen-generated segments.
3. Upload a completed clip for any segment that is already available locally.
4. NewLeaf creates one provider job per segment and stores the manifest in local data.
5. Uploaded clips are applied to their matching provider job by `sequence` and `segmentKey`.
6. Any remaining pending segment can be uploaded later from Content Queue > Media And Upload Status.

This keeps local testing independent of Firebase Storage. Firestore can store manifest metadata, but large video bytes should stay in local disk during development and move to Google Cloud Storage when budget permits.

## Real HeyGen Flow

For local testing with a real HeyGen API key:

1. Set `HEYGEN_API_KEY` in `.env`.
2. Leave `HEYGEN_CALLBACK_URL` empty unless your local API is publicly reachable.
3. Create a segmented/hybrid content job from the admin UI.
4. NewLeaf creates one HeyGen Video Agent request per segment.
5. Open Content Queue > Media And Upload Status.
6. Use `Poll HeyGen` for pending segments until HeyGen returns `completed`.
7. When a segment is completed, NewLeaf downloads the provider `video_url` to the manifest segment path.
8. When every required segment is complete, FFmpeg stitches the final MP4 and the job moves to review.

For webhook-based completion:

1. Expose `/api/v1/webhooks/heygen` through a public HTTPS URL.
2. Set `HEYGEN_CALLBACK_URL` to that full URL, or configure a HeyGen webhook endpoint in the HeyGen console.
3. Set `HEYGEN_WEBHOOK_SECRET` and `HEYGEN_SIGNATURE_HEADER` if your configured webhook sends signatures.

Official HeyGen endpoints used by NewLeaf:

- `POST /v1/video_agent/generate` for segment creation.
- `GET /v1/video_status.get?video_id=...` for polling.

## Manifest

Example:

```json
{
  "projectId": "nvda-iron-condor-2026-05-03",
  "title": "NVDA Iron Condor Strategy",
  "output": "output/nvda-iron-condor-final.mp4",
  "settings": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "audioSampleRate": 48000,
    "videoCodec": "libx264",
    "audioCodec": "aac"
  },
  "segments": [
    {
      "sequence": 10,
      "segmentKey": "intro",
      "title": "Intro",
      "required": true,
      "heygenVideoId": "heygen_intro_placeholder",
      "status": "completed",
      "sourceUrl": "https://example.com/intro.mp4",
      "localFilePath": "input/10-intro.mp4"
    }
  ]
}
```

Relative paths are resolved from the repository root when using the CLI.

## Prepare Clips

Place completed clip files at the `localFilePath` specified in the manifest.

For HeyGen-generated segments, store downloaded clips with sequence-aware names:

```text
input/10-intro.mp4
input/20-market-context.mp4
input/30-strategy-details.mp4
input/40-risk-management.mp4
input/50-disclaimer-outro.mp4
```

For manually uploaded clips later, the admin upload flow should write the uploaded file into the same manifest segment path or update that segment's `localFilePath`.

## Run

```bash
npm run assemble:video -- <path-to-manifest.json>
```

The command:

- validates the manifest;
- validates required completed local files;
- sorts by numeric `sequence`;
- normalizes clips into `temp/{projectId}/`;
- writes `temp/{projectId}/concat.txt`;
- creates the final MP4 at the manifest `output` path.

Check whether all required segments are ready:

```bash
npm run check:project-ready -- <path-to-manifest.json>
```

The readiness check returns ready only when every required segment has `status: "completed"`.

## FFmpeg

FFmpeg must be installed and available in `PATH`.

Every clip is normalized to the manifest settings:

- 1920x1080 by default;
- 30 fps by default;
- H.264 video;
- AAC audio;
- 48 kHz audio;
- stereo audio channels;
- `yuv420p` pixel format.

The video filter is:

```text
scale=1920:1080:force_original_aspect_ratio=decrease,
pad=1920:1080:(ow-iw)/2:(oh-ih)/2,
fps=30
```

Normalization also checks for an audio stream with `ffprobe`. If a clip has no audio, the assembler adds silent stereo AAC audio so concat has a consistent stream layout across all normalized clips.

If FFmpeg is installed but not on `PATH`, run the CLI with explicit binary paths:

```bash
FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe npm run assemble:video -- <path-to-manifest.json>
```

Troubleshooting:

- `FFmpeg is not installed or not available in PATH`: install FFmpeg and restart the terminal.
- `FFprobe is not installed or not available in PATH`: install the full FFmpeg bundle or set `FFPROBE_PATH`.
- `File not found for segment 20`: put the clip at the manifest `localFilePath` or update the manifest.
- `Segment 30 is not completed`: update the segment status only after the clip is actually ready.
- concat failures usually mean a clip has unusual streams beyond the current normalization path.

## Module

The reusable module lives in `packages/video-assembler`.

Main exports:

- `loadManifest(manifestPath)`
- `validateManifest(manifest)`
- `validateSegments(manifest)`
- `getOrderedSegments(manifest)`
- `normalizeClip(inputPath, outputPath, settings)`
- `createConcatFile(normalizedClips, concatFilePath)`
- `stitchClips(concatFilePath, outputPath)`
- `assembleVideo(manifestPath)`
- `downloadSegment(sourceUrl, destinationPath)`
- `SegmentStatusService`
- `updateSegmentCompletion(projectId, heygenVideoId, completedVideoUrl)`
- `isProjectReadyToStitch(projectManifest)`

`downloadSegment` streams provider URLs to disk and refuses to overwrite an existing destination unless called with `{ allowOverwrite: true }`.

## Known Limitations

- The CLI trusts manifest paths. For production, manifest output/input paths should be constrained to a storage root.
- Local assembly requires FFmpeg and FFprobe in the runtime image or environment.
- Large local admin segment uploads currently pass through the API process; production should use signed direct-to-storage uploads.
- The live HeyGen request and polling code is still provider-shape dependent and should be revalidated against the exact HeyGen API plan before production launch.

## Future Extensions

The manifest-first structure is intentionally reusable for:

- HeyGen webhook or polling workers;
- admin clip upload and replacement;
- Firebase Storage / Google Cloud Storage asset writes;
- subtitles and captions;
- intro/outro cards;
- watermarks;
- transitions;
- thumbnail extraction;
- YouTube upload and multi-channel publishing.
