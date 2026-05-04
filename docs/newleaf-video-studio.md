# NewLeaf Video Studio MVP

NewLeaf Video Studio is a focused admin-facing editor for short walkthrough videos. It is not a full nonlinear editor. The MVP stores edits as timeline JSON and renders the final MP4 with FFmpeg only when the admin asks for an export.

## Source Of Truth

The timeline JSON is the source of truth. The uploaded screen recording, voiceover, and avatar files are not mutated during editing. Trim ranges, mute settings, callouts, and picture-in-picture overlays remain metadata until render time.

## What The MVP Supports

- Upload a screen-recorded video.
- Preview the uploaded screen video in the admin UI.
- Set numeric kept sections so unwanted ranges are cut out at render time.
- Mute original audio.
- Upload replacement voiceover audio.
- Upload a HeyGen avatar video and overlay it as bottom-right picture-in-picture.
- Add a simple zoom-in or zoom-out effect over a timeline range.
- Add one simple text callout.
- Delete uploaded project assets or delete the whole local Studio project.
- Render/export a final MP4 through FFmpeg.
- Run the same renderer through CLI or API.

## Folder Structure

CLI samples use repository-relative folders:
The repository no longer commits sample timeline JSON. Create local timeline files outside git-tracked folders when testing.

```text
uploads/10-homepage-screen.mp4
uploads/10-homepage-avatar.mp4
output/newleaf-homepage-pip-poc.mp4
temp/<projectId>/
```

Admin/API projects use local development storage:

```text
.local-data/video-projects/<projectId>/
  timeline.json
  status.json
  uploads/
  output/final.mp4
  temp/<projectId>/
```

## Timeline Example

```json
{
  "projectId": "newleaf-homepage-demo",
  "title": "NewLeaf Homepage Demo",
  "output": "output/newleaf-homepage-pip-poc.mp4",
  "canvas": {
    "width": 1920,
    "height": 1080,
    "fps": 30
  },
  "tracks": [
    {
      "id": "screen-video",
      "type": "video",
      "source": "uploads/10-homepage-screen.mp4",
      "muted": true,
      "clips": [{ "sourceStart": 0, "sourceEnd": 10, "timelineStart": 0 }]
    },
    {
      "id": "avatar-pip",
      "type": "avatar",
      "source": "uploads/10-homepage-avatar.mp4",
      "timelineStart": 5,
      "sourceStart": 0,
      "sourceEnd": 5,
      "position": "bottom-right",
      "width": 340,
      "height": 340
    },
    {
      "id": "zoom-1",
      "type": "zoom",
      "mode": "in",
      "timelineStart": 1,
      "timelineEnd": 6,
      "startScale": 1,
      "endScale": 1.18
    },
    {
      "id": "callout-1",
      "type": "callout",
      "text": "One connected trading workflow",
      "timelineStart": 6,
      "timelineEnd": 10,
      "x": 120,
      "y": 820,
      "fontSize": 42
    }
  ]
}
```

## CLI Render

Install FFmpeg and make sure `ffmpeg` and `ffprobe` are in `PATH`.

```bash
npm run render:timeline -- <path-to-timeline.json>
```

If your Windows FFmpeg build cannot load fontconfig while drawing callouts, set an explicit font:

```env
FFMPEG_FONT_FILE=C:\Windows\Fonts\segoeui.ttf
```

For the sample, place these files first:

```text
uploads/10-homepage-screen.mp4
uploads/10-homepage-avatar.mp4
```

The output will be:

```text
output/newleaf-homepage-pip-poc.mp4
```

## Admin UI

Open the admin console and use **Video Studio**.

Flow:

1. Create or load a project.
2. Upload screen video.
3. Preview it.
4. Set one or more kept source sections. Gaps between those sections are cut from the final render.
5. Choose whether original audio is muted.
6. Optionally upload voiceover and avatar video.
7. Optionally add a zoom-in or zoom-out effect.
8. Edit callout text/start/end.
9. Save timeline.
10. Render MP4.
11. Open the rendered output link.

## API

All routes are under `/api/v1` and require admin/editor authentication.

```text
POST /api/v1/video-projects
DELETE /api/v1/video-projects/:projectId
GET  /api/v1/video-projects/:projectId/timeline
PUT  /api/v1/video-projects/:projectId/timeline
POST /api/v1/video-projects/:projectId/assets?type=screen-video&filename=file.mp4
POST /api/v1/video-projects/:projectId/assets?type=voiceover&filename=voiceover.mp3
POST /api/v1/video-projects/:projectId/assets?type=avatar&filename=avatar.mp4
DELETE /api/v1/video-projects/:projectId/assets/:trackId
POST /api/v1/video-projects/:projectId/render
GET  /api/v1/video-projects/:projectId/status
GET  /api/v1/video-projects/:projectId/assets/uploads/<filename>
GET  /api/v1/video-projects/:projectId/output
```

## Rendering Details

The renderer:

- trims kept clips by `sourceStart` and `sourceEnd`;
- sorts clips by `timelineStart`;
- keeps the original screen recording unchanged;
- creates normalized temporary clips under `temp/<projectId>/`;
- applies zoom effects using FFmpeg `zoompan`;
- overlays avatar video using FFmpeg `overlay`;
- draws callouts using FFmpeg `drawtext`;
- uses an explicit system font for drawtext when one is available, avoiding Windows fontconfig failures;
- maps replacement audio when a voiceover track exists;
- exports H.264/AAC MP4 with `yuv420p`, 30fps, and 48kHz audio.

## Known Limitations

- The UI supports one primary screen track, one voiceover, one avatar overlay, and one callout control.
- Zoom effects are centered and preset-based. Freeform pan/zoom keyframes are not implemented yet.
- Timeline gaps are not rendered as blank sections; kept clips are joined in timeline order.
- Avatar `borderRadius` is stored for future UI compatibility but is not rendered yet.
- Callout box border color is stored but the MVP uses FFmpeg drawtext box styling.
- Render is synchronous in the API for MVP-sized videos.
- Render progress is status-level only; no FFmpeg progress parser is wired yet.

## Future Roadmap

TODO:

- draggable timeline UI;
- waveform with wavesurfer.js;
- draggable overlays with react-konva;
- cursor highlight automation;
- zoom/pan events;
- subtitles;
- YouTube upload after render;
- Firebase Storage / Google Cloud Storage;
- async queue worker;
- detailed FFmpeg render progress.
