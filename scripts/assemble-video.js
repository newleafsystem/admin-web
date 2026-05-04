#!/usr/bin/env node

import { assembleVideo, VideoAssemblerError } from "../packages/video-assembler/src/index.js";

const manifestPath = process.argv[2];

if (!manifestPath) {
  console.error("Usage: node scripts/assemble-video.js <path-to-manifest.json>");
  process.exit(1);
}

try {
  const result = await assembleVideo(manifestPath, {
    ffmpegPath: process.env.FFMPEG_PATH || undefined,
    ffprobePath: process.env.FFPROBE_PATH || undefined
  });
  console.log(`Final output path: ${result.outputPath}`);
} catch (error) {
  if (error instanceof VideoAssemblerError) {
    console.error(error.message);
  } else {
    console.error(error?.message ?? String(error));
  }

  if (process.env.VIDEO_ASSEMBLER_DEBUG && error?.stack) {
    console.error(error.stack);
  }

  process.exit(1);
}
