import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  calculateDuration,
  validateTimeline,
  VideoTimelineError
} from "./videoTimelineRenderer.js";

const tempRoot = path.resolve("packages/video-assembler/temp/video-timeline-validation");

await rm(tempRoot, { recursive: true, force: true });
await mkdir(path.join(tempRoot, "uploads"), { recursive: true });
await writeFile(path.join(tempRoot, "uploads", "screen.mp4"), "screen");
await writeFile(path.join(tempRoot, "uploads", "voiceover.mp3"), "voiceover");
await writeFile(path.join(tempRoot, "uploads", "avatar.mp4"), "avatar");

function baseTimeline() {
  return {
    projectId: "timeline-validation",
    title: "Timeline Validation",
    output: "output/final.mp4",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30
    },
    tracks: [
      {
        id: "screen-video",
        type: "video",
        source: "uploads/screen.mp4",
        muted: true,
        clips: [
          {
            sourceStart: 0,
            sourceEnd: 10,
            timelineStart: 0
          }
        ]
      },
      {
        id: "voiceover",
        type: "audio",
        source: "uploads/voiceover.mp3",
        timelineStart: 0,
        volume: 1
      },
      {
        id: "avatar-pip",
        type: "avatar",
        source: "uploads/avatar.mp4",
        timelineStart: 5,
        sourceStart: 0,
        sourceEnd: 5,
        position: "bottom-right",
        width: 340,
        height: 340
      },
      {
        id: "callout-1",
        type: "callout",
        text: "One connected trading workflow",
        timelineStart: 6,
        timelineEnd: 10,
        x: 120,
        y: 820,
        fontSize: 42
      },
      {
        id: "zoom-1",
        type: "zoom",
        mode: "in",
        timelineStart: 2,
        timelineEnd: 7,
        startScale: 1,
        endScale: 1.18
      }
    ]
  };
}

await validateTimeline(baseTimeline(), {
  baseDir: tempRoot,
  allowedRoot: tempRoot,
  checkFiles: true
});

assert.equal(calculateDuration(baseTimeline()), 10);

await assert.rejects(
  () => validateTimeline({
    ...baseTimeline(),
    tracks: baseTimeline().tracks.map((track) =>
      track.id === "screen-video"
        ? {
          ...track,
          clips: [{ sourceStart: 8, sourceEnd: 4, timelineStart: 0 }]
        }
        : track
    )
  }, { baseDir: tempRoot, allowedRoot: tempRoot }),
  (error) => error instanceof VideoTimelineError && error.code === "INVALID_CLIP_RANGE"
);

await assert.rejects(
  () => validateTimeline({
    ...baseTimeline(),
    tracks: baseTimeline().tracks.map((track) =>
      track.id === "screen-video"
        ? {
          ...track,
          source: "uploads/missing.mp4"
        }
        : track
    )
  }, { baseDir: tempRoot, allowedRoot: tempRoot, checkFiles: true }),
  (error) => error instanceof VideoTimelineError && error.code === "SOURCE_FILE_NOT_FOUND"
);

await assert.rejects(
  () => validateTimeline({
    ...baseTimeline(),
    tracks: baseTimeline().tracks.map((track) =>
      track.id === "avatar-pip"
        ? {
          ...track,
          width: 0
        }
        : track
    )
  }, { baseDir: tempRoot, allowedRoot: tempRoot, checkFiles: false }),
  (error) => error instanceof VideoTimelineError && error.code === "INVALID_NUMBER"
);

await assert.rejects(
  () => validateTimeline({
    ...baseTimeline(),
    tracks: baseTimeline().tracks.map((track) =>
      track.id === "callout-1"
        ? {
          ...track,
          timelineEnd: 2
        }
        : track
    )
  }, { baseDir: tempRoot, allowedRoot: tempRoot, checkFiles: false }),
  (error) => error instanceof VideoTimelineError && error.code === "INVALID_CALLOUT_RANGE"
);

await assert.rejects(
  () => validateTimeline({
    ...baseTimeline(),
    tracks: baseTimeline().tracks.map((track) =>
      track.id === "zoom-1"
        ? {
          ...track,
          startScale: 0.8
        }
        : track
    )
  }, { baseDir: tempRoot, allowedRoot: tempRoot, checkFiles: false }),
  (error) => error instanceof VideoTimelineError && error.code === "INVALID_NUMBER"
);

console.log("Video timeline renderer validation tests passed.");
