import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSegmentStatusService,
  getOrderedSegments,
  getPendingRequiredSegments,
  isProjectReadyToStitch,
  updateSegmentCompletion
} from "./index.js";

const baseDir = path.resolve("temp/segment-status-validation");
const manifestsDir = "manifests";
const manifestPath = path.join(baseDir, manifestsDir, "segment-status-project.json");

await rm(baseDir, { recursive: true, force: true });
await mkdir(path.join(baseDir, manifestsDir), { recursive: true });

const projectManifest = {
  projectId: "segment-status-project",
  title: "Segment Status Project",
  output: "output/final.mp4",
  settings: {},
  segments: [
    {
      sequence: 20,
      segmentKey: "middle",
      required: true,
      heygenVideoId: "heygen_middle",
      status: "processing",
      localFilePath: "input/20-middle.mp4"
    },
    {
      sequence: 10,
      segmentKey: "intro",
      required: true,
      heygenVideoId: "heygen_intro",
      status: "completed",
      sourceUrl: "https://example.com/intro.mp4",
      localFilePath: "input/10-intro.mp4"
    }
  ]
};

await writeManifest(projectManifest);

const service = createSegmentStatusService({ baseDir, manifestsDir });
const mapped = await service.mapHeyGenVideoId("heygen_middle");
assert.equal(mapped.projectId, "segment-status-project");
assert.equal(mapped.sequence, 20);
assert.equal(mapped.segmentKey, "middle");

const initialEntry = await service.loadProjectManifest("segment-status-project");
assert.equal(isProjectReadyToStitch(initialEntry.manifest), false);
assert.deepEqual(getPendingRequiredSegments(initialEntry.manifest), [
  {
    sequence: 20,
    segmentKey: "middle",
    heygenVideoId: "heygen_middle",
    status: "processing"
  }
]);

const update = await updateSegmentCompletion(
  "segment-status-project",
  "heygen_middle",
  "https://example.com/middle-complete.mp4",
  { baseDir, manifestsDir }
);
assert.equal(update.sequence, 20);
assert.equal(update.segmentKey, "middle");
assert.equal(update.readyToStitch, true);

const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(persisted.segments[0].status, "completed");
assert.equal(persisted.segments[0].sourceUrl, "https://example.com/middle-complete.mp4");
assert.equal(isProjectReadyToStitch(persisted), true);

await assert.rejects(
  () => service.mapHeyGenVideoId("unknown_video"),
  /No segment found for HeyGen video ID: unknown_video/
);

const randomCompletionManifest = {
  projectId: "random-completion-project",
  title: "Random Completion Project",
  output: "output/random-final.mp4",
  settings: {},
  segments: [40, 10, 30, 20, 50].map((sequence) => ({
    sequence,
    segmentKey: `segment_${sequence}`,
    required: true,
    heygenVideoId: `heygen_${sequence}`,
    status: "processing",
    localFilePath: `input/${sequence}-segment.mp4`
  }))
};
const randomManifestPath = path.join(baseDir, manifestsDir, "random-completion-project.json");
await writeFile(randomManifestPath, `${JSON.stringify(randomCompletionManifest, null, 2)}\n`, "utf8");

for (const sequence of [40, 10, 30, 20, 50]) {
  const completion = await updateSegmentCompletion(
    "random-completion-project",
    `heygen_${sequence}`,
    `https://example.com/${sequence}.mp4`,
    { baseDir, manifestsDir }
  );
  assert.equal(completion.sequence, sequence);
}

const randomPersisted = JSON.parse(await readFile(randomManifestPath, "utf8"));
assert.equal(isProjectReadyToStitch(randomPersisted), true);
assert.deepEqual(
  getPendingRequiredSegments(randomPersisted),
  []
);
assert.deepEqual(
  getOrderedSegments(randomPersisted).map((segment) => segment.sequence),
  [10, 20, 30, 40, 50]
);

console.log("Segment status service validation tests passed.");

async function writeManifest(manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
