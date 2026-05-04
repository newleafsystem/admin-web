import { createWriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VideoAssemblerError } from "./videoAssembler.js";

export async function downloadSegment(sourceUrl, destinationPath, options = {}) {
  if (!sourceUrl || typeof sourceUrl !== "string") {
    throw new VideoAssemblerError("downloadSegment requires sourceUrl.", "MISSING_SOURCE_URL");
  }
  if (!destinationPath || typeof destinationPath !== "string") {
    throw new VideoAssemblerError("downloadSegment requires destinationPath.", "MISSING_DESTINATION_PATH");
  }

  const baseDir = options.baseDir ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const allowOverwrite = options.allowOverwrite === true;
  const absoluteDestinationPath = path.isAbsolute(destinationPath)
    ? destinationPath
    : path.resolve(baseDir, destinationPath);

  if (typeof fetchImpl !== "function") {
    throw new VideoAssemblerError("No fetch implementation is available for downloadSegment.", "FETCH_UNAVAILABLE");
  }

  const response = await fetchImpl(sourceUrl);
  if (!response.ok) {
    throw new VideoAssemblerError(
      `Unable to download segment from ${sourceUrl}: HTTP ${response.status}`,
      "DOWNLOAD_FAILED"
    );
  }
  if (!response.body) {
    throw new VideoAssemblerError(`Unable to download segment from ${sourceUrl}: empty response body`, "DOWNLOAD_EMPTY_BODY");
  }

  await mkdir(path.dirname(absoluteDestinationPath), { recursive: true });
  if (!allowOverwrite && (await pathExists(absoluteDestinationPath))) {
    throw new VideoAssemblerError(
      `Refusing to overwrite existing segment file: ${destinationPath}`,
      "DOWNLOAD_DESTINATION_EXISTS"
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(absoluteDestinationPath, { flags: allowOverwrite ? "w" : "wx" })
  );
  return absoluteDestinationPath;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
