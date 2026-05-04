import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getOrderedSegments,
  loadManifest,
  validateManifest,
  VideoAssemblerError
} from "./videoAssembler.js";

export class SegmentStatusService {
  constructor(options = {}) {
    this.baseDir = options.baseDir ?? process.cwd();
    this.manifestsDir = options.manifestsDir ?? "manifests";
  }

  async mapHeyGenVideoId(heygenVideoId, options = {}) {
    requireString(heygenVideoId, "heygenVideoId");
    const projectId = options.projectId;
    const manifests = projectId
      ? [await this.loadProjectManifest(projectId)]
      : await this.loadProjectManifests();

    const matches = [];
    for (const entry of manifests) {
      const segment = entry.manifest.segments.find((item) => item.heygenVideoId === heygenVideoId);
      if (segment) {
        matches.push({
          manifestPath: entry.manifestPath,
          projectId: entry.manifest.projectId,
          sequence: Number(segment.sequence),
          segmentKey: segment.segmentKey,
          heygenVideoId,
          segment
        });
      }
    }

    if (matches.length === 0) {
      throw new VideoAssemblerError(`No segment found for HeyGen video ID: ${heygenVideoId}`, "HEYGEN_SEGMENT_NOT_FOUND");
    }

    if (matches.length > 1) {
      throw new VideoAssemblerError(`HeyGen video ID maps to multiple segments: ${heygenVideoId}`, "DUPLICATE_HEYGEN_VIDEO_ID");
    }

    return matches[0];
  }

  async updateSegmentCompletion(projectId, heygenVideoId, completedVideoUrl) {
    requireString(projectId, "projectId");
    requireString(heygenVideoId, "heygenVideoId");
    requireString(completedVideoUrl, "completedVideoUrl");

    const entry = await this.loadProjectManifest(projectId);
    const matches = entry.manifest.segments.filter((item) => item.heygenVideoId === heygenVideoId);

    if (matches.length === 0) {
      throw new VideoAssemblerError(
        `No segment found for project ${projectId} and HeyGen video ID: ${heygenVideoId}`,
        "HEYGEN_SEGMENT_NOT_FOUND"
      );
    }
    if (matches.length > 1) {
      throw new VideoAssemblerError(`HeyGen video ID maps to multiple segments: ${heygenVideoId}`, "DUPLICATE_HEYGEN_VIDEO_ID");
    }

    const segment = matches[0];

    segment.status = "completed";
    segment.sourceUrl = completedVideoUrl;

    await writeFile(entry.manifestPath, `${JSON.stringify(entry.manifest, null, 2)}\n`, "utf8");

    return {
      manifestPath: entry.manifestPath,
      projectId,
      sequence: Number(segment.sequence),
      segmentKey: segment.segmentKey,
      heygenVideoId,
      sourceUrl: completedVideoUrl,
      readyToStitch: isProjectReadyToStitch(entry.manifest)
    };
  }

  async loadProjectManifest(projectId) {
    requireString(projectId, "projectId");
    const manifests = await this.loadProjectManifests();
    const entry = manifests.find((candidate) => candidate.manifest.projectId === projectId);

    if (!entry) {
      throw new VideoAssemblerError(`Project manifest not found for projectId: ${projectId}`, "PROJECT_MANIFEST_NOT_FOUND");
    }

    return entry;
  }

  async loadProjectManifests() {
    const manifestsDir = this.resolvePath(this.manifestsDir);
    let fileNames;
    try {
      fileNames = await readdir(manifestsDir);
    } catch (error) {
      throw new VideoAssemblerError(`Unable to read manifests directory: ${this.manifestsDir}`, "MANIFESTS_DIR_NOT_FOUND", error);
    }

    const manifestFiles = fileNames
      .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));

    const entries = [];
    for (const fileName of manifestFiles) {
      const manifestPath = path.join(manifestsDir, fileName);
      const raw = await readFile(manifestPath, "utf8");
      let manifest;
      try {
        manifest = JSON.parse(raw);
      } catch (error) {
        throw new VideoAssemblerError(`Manifest is not valid JSON: ${manifestPath}`, "INVALID_MANIFEST_JSON", error);
      }

      validateManifest(manifest);
      entries.push({ manifest, manifestPath });
    }

    return entries;
  }

  async loadManifestFromPath(manifestPath) {
    const manifest = await loadManifest(manifestPath, { baseDir: this.baseDir });
    validateManifest(manifest);
    return {
      manifest,
      manifestPath: this.resolvePath(manifestPath)
    };
  }

  resolvePath(filePath) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(this.baseDir, filePath);
  }
}

export function createSegmentStatusService(options = {}) {
  return new SegmentStatusService(options);
}

export async function updateSegmentCompletion(projectId, heygenVideoId, completedVideoUrl, options = {}) {
  return createSegmentStatusService(options).updateSegmentCompletion(projectId, heygenVideoId, completedVideoUrl);
}

export function isProjectReadyToStitch(projectManifest) {
  validateManifest(projectManifest);
  return projectManifest.segments
    .filter((segment) => segment.required === true)
    .every((segment) => segment.status === "completed");
}

export function getPendingRequiredSegments(projectManifest) {
  validateManifest(projectManifest);
  return getOrderedSegments(projectManifest)
    .filter((segment) => segment.required === true && segment.status !== "completed")
    .map((segment) => ({
      sequence: Number(segment.sequence),
      segmentKey: segment.segmentKey,
      heygenVideoId: segment.heygenVideoId,
      status: segment.status
    }));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new VideoAssemblerError(`${label} is required.`, "MISSING_REQUIRED_VALUE");
  }
}
