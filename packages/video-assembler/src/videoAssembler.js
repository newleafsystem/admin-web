import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SETTINGS = {
  width: 1920,
  height: 1080,
  fps: 30,
  audioSampleRate: 48000,
  videoCodec: "libx264",
  audioCodec: "aac"
};

const DEFAULT_LOGGER = {
  info: console.log,
  warn: console.warn,
  error: console.error
};

export class VideoAssemblerError extends Error {
  constructor(message, code = "VIDEO_ASSEMBLER_ERROR", cause = undefined) {
    super(message, { cause });
    this.name = "VideoAssemblerError";
    this.code = code;
  }
}

export async function loadManifest(manifestPath, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const absoluteManifestPath = resolveFromBase(manifestPath, baseDir);

  let raw;
  try {
    raw = await readFile(absoluteManifestPath, "utf8");
  } catch (error) {
    throw new VideoAssemblerError(`Manifest not found: ${manifestPath}`, "MANIFEST_NOT_FOUND", error);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new VideoAssemblerError(`Manifest is not valid JSON: ${manifestPath}`, "INVALID_MANIFEST_JSON", error);
  }
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new VideoAssemblerError("Manifest must be a JSON object.", "INVALID_MANIFEST");
  }

  if (!isNonEmptyString(manifest.projectId)) {
    throw new VideoAssemblerError("Manifest is missing projectId.", "MISSING_PROJECT_ID");
  }

  if (!isNonEmptyString(manifest.output)) {
    throw new VideoAssemblerError("Manifest is missing output path.", "MISSING_OUTPUT");
  }

  if (!Array.isArray(manifest.segments) || manifest.segments.length === 0) {
    throw new VideoAssemblerError("Manifest must include at least one segment.", "MISSING_SEGMENTS");
  }

  return true;
}

export async function validateSegments(manifest, options = {}) {
  validateManifest(manifest);

  const baseDir = options.baseDir ?? process.cwd();
  const checkFiles = options.checkFiles !== false;
  const sequenceValues = new Set();
  const segmentKeys = new Set();

  for (const segment of manifest.segments) {
    validateSegmentShape(segment);

    if (sequenceValues.has(segment.sequence)) {
      throw new VideoAssemblerError(`Duplicate sequence detected: ${segment.sequence}`, "DUPLICATE_SEQUENCE");
    }
    sequenceValues.add(segment.sequence);

    if (segmentKeys.has(segment.segmentKey)) {
      throw new VideoAssemblerError(`Duplicate segmentKey detected: ${segment.segmentKey}`, "DUPLICATE_SEGMENT_KEY");
    }
    segmentKeys.add(segment.segmentKey);
  }

  const orderedSegments = getOrderedSegments(manifest);

  for (const segment of orderedSegments) {
    if (segment.required && segment.status !== "completed") {
      throw new VideoAssemblerError(
        `Segment ${segment.sequence} is not completed: ${segment.segmentKey}`,
        "SEGMENT_NOT_COMPLETED"
      );
    }

    if (!segment.required && segment.status !== "completed") {
      continue;
    }

    if (checkFiles) {
      const absolutePath = resolveFromBase(segment.localFilePath, baseDir);
      if (!(await pathExists(absolutePath))) {
        throw new VideoAssemblerError(
          `File not found for segment ${segment.sequence}: ${segment.localFilePath}`,
          "SEGMENT_FILE_NOT_FOUND"
        );
      }
    }
  }

  return orderedSegments;
}

export function getOrderedSegments(manifest) {
  validateManifest(manifest);
  return manifest.segments
    .filter((segment) => segment?.required === true || segment?.status === "completed")
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

export async function normalizeClip(inputPath, outputPath, settings = {}, options = {}) {
  const resolvedSettings = normalizeSettings(settings);
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const logger = options.logger ?? DEFAULT_LOGGER;
  const hasAudio = await hasAudioStream(inputPath, { ffprobePath });

  await mkdir(path.dirname(outputPath), { recursive: true });

  const videoFilter = [
    `scale=${resolvedSettings.width}:${resolvedSettings.height}:force_original_aspect_ratio=decrease`,
    `pad=${resolvedSettings.width}:${resolvedSettings.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${resolvedSettings.fps}`
  ].join(",");

  const args = [
    "-y",
    "-i",
    inputPath,
    ...(hasAudio ? [] : [
      "-f",
      "lavfi",
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${resolvedSettings.audioSampleRate}`
    ]),
    "-map",
    "0:v:0",
    "-map",
    hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    videoFilter,
    "-c:v",
    resolvedSettings.videoCodec,
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    resolvedSettings.audioCodec,
    "-ar",
    String(resolvedSettings.audioSampleRate),
    "-ac",
    "2",
    ...(hasAudio ? [] : ["-shortest"]),
    "-movflags",
    "+faststart",
    outputPath
  ];

  logger.info?.(`Normalizing ${inputPath}`);
  await runCommand(ffmpegPath, args, { commandName: "FFmpeg" });
  return outputPath;
}

export async function createConcatFile(normalizedClips, concatFilePath) {
  if (!Array.isArray(normalizedClips) || normalizedClips.length === 0) {
    throw new VideoAssemblerError("Cannot create concat file without normalized clips.", "MISSING_NORMALIZED_CLIPS");
  }

  await mkdir(path.dirname(concatFilePath), { recursive: true });

  const contents = normalizedClips
    .map((clipPath) => `file '${escapeConcatPath(path.resolve(clipPath))}'`)
    .join("\n");

  await writeFile(concatFilePath, `${contents}\n`, "utf8");
  return concatFilePath;
}

export async function stitchClips(concatFilePath, outputPath, options = {}) {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const logger = options.logger ?? DEFAULT_LOGGER;

  await mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFilePath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath
  ];

  logger.info?.("Stitching final video");
  await runCommand(ffmpegPath, args, { commandName: "FFmpeg" });
  return outputPath;
}

export async function assembleVideo(manifestPath, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const logger = options.logger ?? DEFAULT_LOGGER;
  const manifest = await loadManifest(manifestPath, { baseDir });
  const settings = normalizeSettings(manifest.settings);
  const outputPath = resolveFromBase(manifest.output, baseDir);
  const tempRoot = resolveFromBase(options.tempDir ?? "temp", baseDir);
  const projectTempDir = path.join(tempRoot, sanitizePathSegment(manifest.projectId));

  validateManifest(manifest);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const orderedSegments = await validateSegments(manifest, { baseDir, checkFiles: true });

  logger.info?.(`Project loaded: ${manifest.projectId}`);
  logger.info?.(`Segments in manifest: ${manifest.segments.length}`);
  logger.info?.(
    `Ordered timeline: ${orderedSegments.map((segment) => `${segment.sequence}:${segment.segmentKey}`).join(" -> ")}`
  );

  if (options.cleanTemp !== false) {
    await rm(projectTempDir, { recursive: true, force: true });
  }
  await mkdir(projectTempDir, { recursive: true });

  const normalizedClips = [];
  for (const [index, segment] of orderedSegments.entries()) {
    if (!segment.required && segment.status !== "completed") {
      continue;
    }

    const inputPath = resolveFromBase(segment.localFilePath, baseDir);
    const normalizedPath = path.join(projectTempDir, `${padSequence(segment.sequence)}-${slugify(segment.segmentKey)}.mp4`);

    logger.info?.(`Normalizing clip ${index + 1}/${orderedSegments.length}: ${segment.sequence} ${segment.segmentKey}`);
    await normalizeClip(inputPath, normalizedPath, settings, {
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      logger: options.clipLogger ?? { info: () => {} }
    });
    normalizedClips.push(normalizedPath);
  }

  const concatFilePath = path.join(projectTempDir, "concat.txt");
  await createConcatFile(normalizedClips, concatFilePath);
  logger.info?.(`Concat file created: ${concatFilePath}`);

  await stitchClips(concatFilePath, outputPath, {
    ffmpegPath: options.ffmpegPath,
    logger
  });

  logger.info?.(`Output created: ${outputPath}`);

  return {
    manifest,
    orderedSegments,
    normalizedClips,
    concatFilePath,
    outputPath
  };
}

function validateSegmentShape(segment) {
  if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
    throw new VideoAssemblerError("Every segment must be an object.", "INVALID_SEGMENT");
  }

  if (!Number.isFinite(Number(segment.sequence))) {
    throw new VideoAssemblerError(`Segment is missing numeric sequence: ${segment.segmentKey ?? "unknown"}`, "MISSING_SEQUENCE");
  }
  segment.sequence = Number(segment.sequence);

  if (!isNonEmptyString(segment.segmentKey)) {
    throw new VideoAssemblerError(`Segment ${segment.sequence} is missing segmentKey.`, "MISSING_SEGMENT_KEY");
  }

  if (typeof segment.required !== "boolean") {
    throw new VideoAssemblerError(`Segment ${segment.sequence} is missing required flag.`, "MISSING_REQUIRED_FLAG");
  }

  if (!isNonEmptyString(segment.status)) {
    throw new VideoAssemblerError(`Segment ${segment.sequence} is missing status.`, "MISSING_STATUS");
  }

  if (!isNonEmptyString(segment.localFilePath)) {
    throw new VideoAssemblerError(`Segment ${segment.sequence} is missing localFilePath.`, "MISSING_LOCAL_FILE_PATH");
  }
}

function normalizeSettings(settings = {}) {
  const resolved = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  return {
    width: positiveNumber(resolved.width, "settings.width"),
    height: positiveNumber(resolved.height, "settings.height"),
    fps: positiveNumber(resolved.fps, "settings.fps"),
    audioSampleRate: positiveNumber(resolved.audioSampleRate, "settings.audioSampleRate"),
    videoCodec: resolved.videoCodec || DEFAULT_SETTINGS.videoCodec,
    audioCodec: resolved.audioCodec || DEFAULT_SETTINGS.audioCodec
  };
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new VideoAssemblerError(`${label} must be a positive number.`, "INVALID_SETTINGS");
  }
  return number;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(commandSpawnError(error, command, options));
      return;
    }
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(commandSpawnError(error, command, options));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new VideoAssemblerError(
          `${options.commandName ?? command} failed with exit code ${code}: ${lastLines(stderr)}`,
          "COMMAND_FAILED"
        )
      );
    });
  });
}

async function hasAudioStream(inputPath, options = {}) {
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const args = [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    inputPath
  ];
  const output = await runCommandCapture(ffprobePath, args, { commandName: "FFprobe" });
  return output.trim().length > 0;
}

async function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(commandSpawnError(error, command, options));
      return;
    }
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(commandSpawnError(error, command, options));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new VideoAssemblerError(
          `${options.commandName ?? command} failed with exit code ${code}: ${lastLines(stderr)}`,
          "COMMAND_FAILED"
        )
      );
    });
  });
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveFromBase(filePath, baseDir) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function escapeConcatPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function padSequence(sequence) {
  return String(sequence).padStart(5, "0");
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "segment";
}

function sanitizePathSegment(value) {
  return slugify(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function lastLines(value, count = 10) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .join("\n");
}

function commandSpawnError(error, command, options = {}) {
  if (error?.code === "ENOENT") {
    return new VideoAssemblerError(`${options.commandName ?? command} is not installed or not available in PATH`, "COMMAND_NOT_FOUND", error);
  }
  if (isExecutionPermissionError(error)) {
    return new VideoAssemblerError(`${options.commandName ?? command} could not be executed: ${error.message}`, "COMMAND_NOT_EXECUTABLE", error);
  }
  return error;
}

function isExecutionPermissionError(error) {
  return (
    error?.code === "EACCES" ||
    error?.code === "EPERM" ||
    /(?:EACCES|EPERM|permission denied|access is denied)/i.test(error?.message ?? "")
  );
}
