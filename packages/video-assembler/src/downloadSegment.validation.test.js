import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { downloadSegment } from "./downloadSegment.js";

const baseDir = path.resolve("temp/download-segment-validation");
await rm(baseDir, { recursive: true, force: true });

const destinationPath = "downloads/segment.mp4";
const downloadedPath = await downloadSegment("https://example.com/segment.mp4", destinationPath, {
  baseDir,
  fetchImpl: async () => responseFromText("segment bytes")
});

assert.equal(downloadedPath, path.join(baseDir, destinationPath));
assert.equal(await readFile(downloadedPath, "utf8"), "segment bytes");

await assert.rejects(
  () => downloadSegment("https://example.com/segment.mp4", destinationPath, {
    baseDir,
    fetchImpl: async () => responseFromText("new bytes")
  }),
  /Refusing to overwrite existing segment file/
);

await downloadSegment("https://example.com/segment.mp4", destinationPath, {
  baseDir,
  allowOverwrite: true,
  fetchImpl: async () => responseFromText("replacement bytes")
});
assert.equal(await readFile(downloadedPath, "utf8"), "replacement bytes");

await assert.rejects(
  () => downloadSegment("https://example.com/missing.mp4", "downloads/missing.mp4", {
    baseDir,
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      body: responseBody("")
    })
  }),
  /HTTP 404/
);

console.log("Download segment validation tests passed.");

function responseFromText(text) {
  return {
    ok: true,
    status: 200,
    body: responseBody(text)
  };
}

function responseBody(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}
