import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getOrderedSegments,
  validateManifest,
  validateSegments
} from "./videoAssembler.js";

const baseDir = path.resolve("temp/video-assembler-validation");

await rm(baseDir, { recursive: true, force: true });
await mkdir(path.join(baseDir, "input"), { recursive: true });

async function touch(relativePath) {
  await writeFile(path.join(baseDir, relativePath), "placeholder");
}

function manifest(overrides = {}) {
  return {
    projectId: "validation-test",
    output: "output/final.mp4",
    settings: {},
    segments: [
      {
        sequence: 30,
        segmentKey: "third",
        required: true,
        status: "completed",
        localFilePath: "input/30-third.mp4"
      },
      {
        sequence: 10,
        segmentKey: "first",
        required: true,
        status: "completed",
        localFilePath: "input/10-first.mp4"
      },
      {
        sequence: 20,
        segmentKey: "second",
        required: true,
        status: "completed",
        localFilePath: "input/20-second.mp4"
      }
    ],
    ...overrides
  };
}

await touch("input/10-first.mp4");
await touch("input/20-second.mp4");
await touch("input/30-third.mp4");

validateManifest(manifest());
assert.deepEqual(getOrderedSegments(manifest()).map((segment) => segment.sequence), [10, 20, 30]);

const ordered = await validateSegments(manifest(), { baseDir });
assert.deepEqual(ordered.map((segment) => segment.segmentKey), ["first", "second", "third"]);

assert.deepEqual(
  getOrderedSegments(manifest({
    segments: [
      {
        sequence: 40,
        segmentKey: "risk",
        required: true,
        status: "completed",
        localFilePath: "input/40-risk.mp4"
      },
      {
        sequence: 10,
        segmentKey: "intro",
        required: true,
        status: "completed",
        localFilePath: "input/10-intro.mp4"
      },
      {
        sequence: 30,
        segmentKey: "details",
        required: true,
        status: "completed",
        localFilePath: "input/30-details.mp4"
      },
      {
        sequence: 20,
        segmentKey: "context",
        required: true,
        status: "completed",
        localFilePath: "input/20-context.mp4"
      },
      {
        sequence: 50,
        segmentKey: "outro",
        required: true,
        status: "completed",
        localFilePath: "input/50-outro.mp4"
      }
    ]
  })).map((segment) => segment.sequence),
  [10, 20, 30, 40, 50]
);

assert.deepEqual(
  await validateSegments(manifest({
    segments: [
      {
        sequence: 10,
        segmentKey: "first",
        required: true,
        status: "completed",
        localFilePath: "input/10-first.mp4"
      },
      {
        sequence: 20,
        segmentKey: "optional_pending",
        required: false,
        status: "processing",
        localFilePath: "input/optional-pending.mp4"
      },
      {
        sequence: 30,
        segmentKey: "third",
        required: true,
        status: "completed",
        localFilePath: "input/30-third.mp4"
      }
    ]
  }), { baseDir }).then((segments) => segments.map((segment) => segment.segmentKey)),
  ["first", "third"]
);

assert.throws(
  () => validateManifest({ ...manifest(), projectId: "" }),
  /Manifest is missing projectId/
);

assert.throws(
  () => validateManifest({ ...manifest(), output: "" }),
  /Manifest is missing output path/
);

assert.throws(
  () => validateManifest({ ...manifest(), segments: [] }),
  /Manifest must include at least one segment/
);

await assert.rejects(
  () => validateSegments(manifest({
    segments: [
      ...manifest().segments,
      {
        sequence: 30,
        segmentKey: "duplicate",
        required: true,
        status: "completed",
        localFilePath: "input/duplicate.mp4"
      }
    ]
  }), { baseDir }),
  /Duplicate sequence detected: 30/
);

await assert.rejects(
  () => validateSegments(manifest({
    segments: [
      {
        sequence: 10,
        segmentKey: "first",
        required: true,
        status: "processing",
        localFilePath: "input/10-first.mp4"
      }
    ]
  }), { baseDir }),
  /Segment 10 is not completed/
);

await assert.rejects(
  () => validateSegments(manifest({
    segments: [
      {
        sequence: 10,
        segmentKey: "missing_file",
        required: true,
        status: "completed",
        localFilePath: "input/missing.mp4"
      }
    ]
  }), { baseDir }),
  /File not found for segment 10/
);

await assert.rejects(
  () => validateSegments(manifest({
    segments: [
      {
        sequence: 10,
        segmentKey: "same",
        required: true,
        status: "completed",
        localFilePath: "input/10-first.mp4"
      },
      {
        sequence: 20,
        segmentKey: "same",
        required: true,
        status: "completed",
        localFilePath: "input/20-second.mp4"
      }
    ]
  }), { baseDir }),
  /Duplicate segmentKey detected: same/
);

console.log("Video assembler validation tests passed.");
