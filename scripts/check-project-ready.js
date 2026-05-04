#!/usr/bin/env node

import {
  getPendingRequiredSegments,
  isProjectReadyToStitch,
  loadManifest,
  VideoAssemblerError
} from "../packages/video-assembler/src/index.js";

const manifestPath = process.argv[2];

if (!manifestPath) {
  console.error("Usage: node scripts/check-project-ready.js <path-to-manifest.json>");
  process.exit(1);
}

try {
  const manifest = await loadManifest(manifestPath);
  const ready = isProjectReadyToStitch(manifest);

  if (ready) {
    console.log(`Project ${manifest.projectId} is ready for stitching.`);
    process.exit(0);
  }

  console.log(`Project ${manifest.projectId} is not ready for stitching.`);
  console.log("Pending required segments:");

  for (const segment of getPendingRequiredSegments(manifest)) {
    const heygenLabel = segment.heygenVideoId ? `, heygenVideoId: ${segment.heygenVideoId}` : "";
    console.log(`- ${segment.sequence} ${segment.segmentKey} (status: ${segment.status}${heygenLabel})`);
  }

  process.exit(2);
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
