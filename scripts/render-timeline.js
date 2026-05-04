#!/usr/bin/env node

import { renderTimeline, VideoTimelineError } from "../packages/video-assembler/src/index.js";

const timelinePath = process.argv[2];

if (!timelinePath) {
  console.error("Usage: node scripts/render-timeline.js <path-to-timeline.json>");
  process.exit(1);
}

try {
  const result = await renderTimeline(timelinePath, {
    ffmpegPath: process.env.FFMPEG_PATH || undefined,
    ffprobePath: process.env.FFPROBE_PATH || undefined,
    fontFile: process.env.FFMPEG_FONT_FILE || undefined
  });
  console.log(`Final output path: ${result.outputPath}`);
} catch (error) {
  if (error instanceof VideoTimelineError) {
    console.error(error.message);
  } else {
    console.error(error?.message ?? String(error));
  }

  if (process.env.VIDEO_STUDIO_DEBUG && error?.stack) {
    console.error(error.stack);
  }

  process.exit(1);
}
