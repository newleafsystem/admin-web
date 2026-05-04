import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CANVAS = {
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

export class VideoTimelineError extends Error {
  constructor(message, code = "VIDEO_TIMELINE_ERROR", cause = undefined) {
    super(message, { cause });
    this.name = "VideoTimelineError";
    this.code = code;
  }
}

export async function loadTimeline(timelinePath, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const absoluteTimelinePath = resolvePath(timelinePath, baseDir, options);
  let raw;
  try {
    raw = await readFile(absoluteTimelinePath, "utf8");
  } catch (error) {
    throw new VideoTimelineError(`Timeline not found: ${timelinePath}`, "TIMELINE_NOT_FOUND", error);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new VideoTimelineError(`Timeline is not valid JSON: ${timelinePath}`, "INVALID_TIMELINE_JSON", error);
  }
}

export async function validateTimeline(timeline, options = {}) {
  if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) {
    throw new VideoTimelineError("Timeline must be a JSON object.", "INVALID_TIMELINE");
  }
  if (!isNonEmptyString(timeline.projectId)) {
    throw new VideoTimelineError("Timeline is missing projectId.", "MISSING_PROJECT_ID");
  }
  if (!isNonEmptyString(timeline.output)) {
    throw new VideoTimelineError("Timeline is missing output path.", "MISSING_OUTPUT");
  }

  if (!timeline.canvas || typeof timeline.canvas !== "object" || Array.isArray(timeline.canvas)) {
    throw new VideoTimelineError("Timeline is missing canvas settings.", "MISSING_CANVAS");
  }
  for (const field of ["width", "height", "fps"]) {
    if (timeline.canvas[field] === undefined || timeline.canvas[field] === null) {
      throw new VideoTimelineError(`Timeline canvas is missing ${field}.`, "MISSING_CANVAS_FIELD");
    }
  }

  const canvas = normalizeCanvas(timeline.canvas);
  if (!Array.isArray(timeline.tracks) || timeline.tracks.length === 0) {
    throw new VideoTimelineError("Timeline must include at least one track.", "MISSING_TRACKS");
  }

  const videoTracks = timeline.tracks.filter((track) => track?.type === "video");
  if (videoTracks.length === 0) {
    throw new VideoTimelineError("Timeline must include at least one video track.", "MISSING_VIDEO_TRACK");
  }

  for (const track of timeline.tracks) {
    await validateTrack(track, { ...options, canvas });
  }

  const outputPath = resolvePath(timeline.output, options.baseDir ?? process.cwd(), options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  return true;
}

export function calculateDuration(timeline) {
  if (!Array.isArray(timeline?.tracks)) return 0;
  let duration = 0;
  for (const track of timeline.tracks) {
    if (track.type === "video") {
      for (const clip of track.clips ?? []) {
        duration = Math.max(duration, Number(clip.timelineStart) + Number(clip.sourceEnd) - Number(clip.sourceStart));
      }
    }
    if (track.type === "zoom") {
      duration = Math.max(duration, Number(track.timelineEnd));
    }
    if (track.type === "avatar") {
      duration = Math.max(duration, Number(track.timelineStart) + Number(track.sourceEnd) - Number(track.sourceStart));
    }
    if (track.type === "callout") {
      duration = Math.max(duration, Number(track.timelineEnd));
    }
  }
  return Math.max(0, duration);
}

export async function normalizeSourceVideo(inputPath, outputPath, canvas = {}, options = {}) {
  const resolvedCanvas = normalizeCanvas(canvas);
  const hasAudio = await hasAudioStream(inputPath, options).catch(() => false);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = [
    "-y",
    "-i",
    inputPath,
    ...(hasAudio ? [] : silentAudioInput(resolvedCanvas.audioSampleRate)),
    "-map",
    "0:v:0",
    "-map",
    hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    baseVideoFilter(resolvedCanvas),
    "-c:v",
    resolvedCanvas.videoCodec,
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    resolvedCanvas.audioCodec,
    "-ar",
    String(resolvedCanvas.audioSampleRate),
    "-ac",
    "2",
    ...(hasAudio ? [] : ["-shortest"]),
    "-movflags",
    "+faststart",
    outputPath
  ];
  await runCommand(options.ffmpegPath ?? "ffmpeg", args, { commandName: "FFmpeg" });
  return outputPath;
}

export async function renderVideoTrack(timeline, tempDir, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const canvas = normalizeCanvas(timeline.canvas);
  const videoTrack = timeline.tracks.find((track) => track.type === "video");
  const clips = [...(videoTrack?.clips ?? [])].sort((left, right) => Number(left.timelineStart) - Number(right.timelineStart));
  const hasReplacementAudio = timeline.tracks.some((track) => track.type === "audio" && isNonEmptyString(track.source));
  const renderedClips = [];

  await mkdir(tempDir, { recursive: true });

  for (const [index, clip] of clips.entries()) {
    const inputPath = resolvePath(videoTrack.source, baseDir, options);
    const outputPath = path.join(tempDir, `video-clip-${String(index + 1).padStart(3, "0")}.mp4`);
    const duration = Number(clip.sourceEnd) - Number(clip.sourceStart);
    const sourceHasAudio = await hasAudioStream(inputPath, options).catch(() => false);
    const useSourceAudio = !videoTrack.muted && !hasReplacementAudio && sourceHasAudio;
    const audioInputArgs = useSourceAudio ? [] : silentAudioInput(canvas.audioSampleRate);

    const args = [
      "-y",
      "-ss",
      String(clip.sourceStart),
      "-t",
      String(duration),
      "-i",
      inputPath,
      ...audioInputArgs,
      "-map",
      "0:v:0",
      "-map",
      useSourceAudio ? "0:a:0" : "1:a:0",
      "-vf",
      baseVideoFilter(canvas),
      "-c:v",
      canvas.videoCodec,
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      canvas.audioCodec,
      "-ar",
      String(canvas.audioSampleRate),
      "-ac",
      "2",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath
    ];

    options.logger?.info?.(`Rendering video clip ${index + 1}/${clips.length}`);
    await runCommand(options.ffmpegPath ?? "ffmpeg", args, { commandName: "FFmpeg" });
    renderedClips.push(outputPath);
  }

  const concatFilePath = path.join(tempDir, "video-clips.txt");
  await writeFile(concatFilePath, `${renderedClips.map((clipPath) => `file '${escapeConcatPath(clipPath)}'`).join("\n")}\n`, "utf8");
  const outputPath = path.join(tempDir, "base-video.mp4");
  await runCommand(options.ffmpegPath ?? "ffmpeg", [
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
  ], { commandName: "FFmpeg" });
  return outputPath;
}

export async function renderAudioTrack(timeline, tempDir, options = {}) {
  const audioTrack = timeline.tracks.find((track) => track.type === "audio" && isNonEmptyString(track.source));
  if (!audioTrack) return null;

  const baseDir = options.baseDir ?? process.cwd();
  const canvas = normalizeCanvas(timeline.canvas);
  const duration = calculateDuration(timeline);
  const inputPath = resolvePath(audioTrack.source, baseDir, options);
  const outputPath = path.join(tempDir, "replacement-audio.m4a");
  const delayMs = Math.max(0, Math.round(Number(audioTrack.timelineStart ?? 0) * 1000));
  const volume = finiteNumber(audioTrack.volume, 1, "audio.volume");
  const audioFilter = [`volume=${volume}`, `adelay=${delayMs}:all=1`, "apad"].join(",");

  await runCommand(options.ffmpegPath ?? "ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-filter:a",
    audioFilter,
    "-t",
    String(duration),
    "-c:a",
    canvas.audioCodec,
    "-ar",
    String(canvas.audioSampleRate),
    "-ac",
    "2",
    outputPath
  ], { commandName: "FFmpeg" });
  return outputPath;
}

export async function renderAvatarOverlay(timeline, baseVideoPath, outputPath, options = {}) {
  const avatarTracks = timeline.tracks.filter((track) => track.type === "avatar");
  if (avatarTracks.length === 0) return baseVideoPath;

  let currentInput = baseVideoPath;
  const baseDir = options.baseDir ?? process.cwd();
  const canvas = normalizeCanvas(timeline.canvas);
  for (const [index, track] of avatarTracks.entries()) {
    const currentOutput = index === avatarTracks.length - 1
      ? outputPath
      : path.join(path.dirname(outputPath), `avatar-overlay-${index + 1}.mp4`);
    const avatarInput = resolvePath(track.source, baseDir, options);
    const position = avatarPosition(track, canvas);
    const start = Number(track.timelineStart);
    const end = start + Number(track.sourceEnd) - Number(track.sourceStart);
    const avatarLabel = `avatar${index}`;
    const filter = [
      `[1:v]trim=start=${Number(track.sourceStart)}:end=${Number(track.sourceEnd)},setpts=PTS-STARTPTS+${start}/TB,scale=${Number(track.width)}:${Number(track.height)},fps=${canvas.fps},format=rgba[${avatarLabel}]`,
      `[0:v][${avatarLabel}]overlay=${position.x}:${position.y}:enable='between(t,${start},${end})'[ov${index}]`,
      `[ov${index}]drawbox=x=${position.x}:y=${position.y}:w=${Number(track.width)}:h=${Number(track.height)}:color=${ffmpegColor(track.borderColor ?? "#C9A96E")}:t=4:enable='between(t,${start},${end})'[v]`
    ].join(";");

    await runCommand(options.ffmpegPath ?? "ffmpeg", [
      "-y",
      "-i",
      currentInput,
      "-i",
      avatarInput,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-map",
      "0:a:0?",
      "-c:v",
      canvas.videoCodec,
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      currentOutput
    ], { commandName: "FFmpeg" });
    currentInput = currentOutput;
  }
  return currentInput;
}

export async function renderCallouts(timeline, baseVideoPath, outputPath, options = {}) {
  const calloutTracks = timeline.tracks.filter((track) => track.type === "callout");
  if (calloutTracks.length === 0) return baseVideoPath;

  const canvas = normalizeCanvas(timeline.canvas);
  const fontOption = await drawtextFontOption(options);
  const filters = [];
  let inputLabel = "0:v";
  for (const [index, track] of calloutTracks.entries()) {
    const outputLabel = index === calloutTracks.length - 1 ? "v" : `callout${index}`;
    const start = Number(track.timelineStart);
    const end = Number(track.timelineEnd);
    filters.push(
      `[${inputLabel}]drawtext=${fontOption}text='${escapeDrawtext(track.text)}':x=${Number(track.x)}:y=${Number(track.y)}:fontsize=${Number(track.fontSize)}:fontcolor=${ffmpegColor(track.fontColor ?? "#F7F5EF")}:box=1:boxcolor=${ffmpegColor(track.boxColor ?? "#0B2D23")}@0.86:boxborderw=24:enable='between(t,${start},${end})'[${outputLabel}]`
    );
    inputLabel = outputLabel;
  }

  await runCommand(options.ffmpegPath ?? "ffmpeg", [
    "-y",
    "-i",
    baseVideoPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    "-map",
    "0:a:0?",
    "-c:v",
    canvas.videoCodec,
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputPath
  ], { commandName: "FFmpeg" });
  return outputPath;
}

export async function renderZoomEffects(timeline, baseVideoPath, outputPath, options = {}) {
  const zoomTracks = timeline.tracks.filter((track) => track.type === "zoom");
  if (zoomTracks.length === 0) return baseVideoPath;

  const canvas = normalizeCanvas(timeline.canvas);
  const zoomExpression = buildZoomExpression(zoomTracks, canvas.fps);
  const filter = [
    `zoompan=z='${zoomExpression}'`,
    "x='iw/2-(iw/zoom/2)'",
    "y='ih/2-(ih/zoom/2)'",
    "d=1",
    `s=${canvas.width}x${canvas.height}`,
    `fps=${canvas.fps}`
  ].join(":");

  await runCommand(options.ffmpegPath ?? "ffmpeg", [
    "-y",
    "-i",
    baseVideoPath,
    "-filter_complex",
    `[0:v]${filter}[v]`,
    "-map",
    "[v]",
    "-map",
    "0:a:0?",
    "-c:v",
    canvas.videoCodec,
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputPath
  ], { commandName: "FFmpeg" });
  return outputPath;
}

export async function exportFinalVideo(timeline, videoPath, audioPath, outputPath, options = {}) {
  const canvas = normalizeCanvas(timeline.canvas);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = audioPath
    ? [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      canvas.videoCodec,
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      canvas.audioCodec,
      "-ar",
      String(canvas.audioSampleRate),
      "-ac",
      "2",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath
    ]
    : [
      "-y",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      canvas.videoCodec,
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      canvas.audioCodec,
      "-ar",
      String(canvas.audioSampleRate),
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outputPath
    ];
  await runCommand(options.ffmpegPath ?? "ffmpeg", args, { commandName: "FFmpeg" });
  return outputPath;
}

export async function renderTimeline(timelinePath, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const logger = options.logger ?? DEFAULT_LOGGER;
  const timeline = await loadTimeline(timelinePath, options);
  await validateTimeline(timeline, { ...options, baseDir, checkFiles: true });

  const tempRoot = resolvePath(options.tempDir ?? "temp", baseDir, options);
  const projectTempDir = path.join(tempRoot, sanitizePathSegment(timeline.projectId));
  const outputPath = resolvePath(timeline.output, baseDir, options);

  logger.info?.(`Project loaded: ${timeline.projectId}`);
  logger.info?.(`Tracks in timeline: ${timeline.tracks.length}`);
  logger.info?.(`Calculated duration: ${calculateDuration(timeline)}s`);

  if (options.cleanTemp !== false) {
    await rm(projectTempDir, { recursive: true, force: true });
  }
  await mkdir(projectTempDir, { recursive: true });

  logger.info?.("Rendering base video track");
  const baseVideoPath = await renderVideoTrack(timeline, projectTempDir, { ...options, baseDir, logger });

  logger.info?.("Rendering zoom effects");
  const zoomVideoPath = await renderZoomEffects(
    timeline,
    baseVideoPath,
    path.join(projectTempDir, "with-zoom.mp4"),
    { ...options, baseDir, logger }
  );

  logger.info?.("Rendering avatar overlays");
  const avatarVideoPath = await renderAvatarOverlay(
    timeline,
    zoomVideoPath,
    path.join(projectTempDir, "with-avatar.mp4"),
    { ...options, baseDir, logger }
  );

  logger.info?.("Rendering callout overlays");
  const calloutVideoPath = await renderCallouts(
    timeline,
    avatarVideoPath,
    path.join(projectTempDir, "with-callouts.mp4"),
    { ...options, baseDir, logger }
  );

  logger.info?.("Rendering audio track");
  const audioPath = await renderAudioTrack(timeline, projectTempDir, { ...options, baseDir, logger });

  logger.info?.("Exporting final MP4");
  await exportFinalVideo(timeline, calloutVideoPath, audioPath, outputPath, { ...options, baseDir, logger });
  logger.info?.(`Output created: ${outputPath}`);

  return {
    timeline,
    duration: calculateDuration(timeline),
    tempDir: projectTempDir,
    baseVideoPath,
    audioPath,
    outputPath
  };
}

async function validateTrack(track, options = {}) {
  if (!track || typeof track !== "object" || Array.isArray(track)) {
    throw new VideoTimelineError("Every track must be an object.", "INVALID_TRACK");
  }
  if (!isNonEmptyString(track.id)) {
    throw new VideoTimelineError("Track is missing id.", "MISSING_TRACK_ID");
  }
  if (!isNonEmptyString(track.type)) {
    throw new VideoTimelineError(`Track ${track.id} is missing type.`, "MISSING_TRACK_TYPE");
  }

  if (["video", "audio", "avatar"].includes(track.type)) {
    if (!isNonEmptyString(track.source)) {
      throw new VideoTimelineError(`Track ${track.id} is missing source.`, "MISSING_TRACK_SOURCE");
    }
    if (options.checkFiles !== false && !(await pathExists(resolvePath(track.source, options.baseDir ?? process.cwd(), options)))) {
      throw new VideoTimelineError(`Source file not found for track ${track.id}: ${track.source}`, "SOURCE_FILE_NOT_FOUND");
    }
  }

  if (track.type === "video") {
    if (!Array.isArray(track.clips) || track.clips.length === 0) {
      throw new VideoTimelineError(`Video track ${track.id} must include clips.`, "MISSING_VIDEO_CLIPS");
    }
    for (const clip of track.clips) {
      validateClip(track, clip);
    }
  } else if (track.type === "audio") {
    finiteNumber(track.timelineStart ?? 0, 0, `${track.id}.timelineStart`);
    finiteNumber(track.volume ?? 1, 1, `${track.id}.volume`);
  } else if (track.type === "avatar") {
    validateAvatar(track);
  } else if (track.type === "callout") {
    validateCallout(track);
  } else if (track.type === "zoom") {
    validateZoom(track);
  } else {
    throw new VideoTimelineError(`Unsupported track type: ${track.type}`, "UNSUPPORTED_TRACK_TYPE");
  }
}

function validateClip(track, clip) {
  if (!clip || typeof clip !== "object" || Array.isArray(clip)) {
    throw new VideoTimelineError(`Video track ${track.id} contains an invalid clip.`, "INVALID_CLIP");
  }
  const sourceStart = finiteNumber(clip.sourceStart, 0, `${track.id}.sourceStart`);
  const sourceEnd = finiteNumber(clip.sourceEnd, null, `${track.id}.sourceEnd`);
  finiteNumber(clip.timelineStart, 0, `${track.id}.timelineStart`);
  if (sourceEnd <= sourceStart) {
    throw new VideoTimelineError(`Clip sourceEnd must be greater than sourceStart for track ${track.id}.`, "INVALID_CLIP_RANGE");
  }
}

function validateAvatar(track) {
  const sourceStart = finiteNumber(track.sourceStart, 0, `${track.id}.sourceStart`);
  const sourceEnd = finiteNumber(track.sourceEnd, null, `${track.id}.sourceEnd`);
  finiteNumber(track.timelineStart, 0, `${track.id}.timelineStart`);
  if (sourceEnd <= sourceStart) {
    throw new VideoTimelineError(`Avatar track ${track.id} sourceEnd must be greater than sourceStart.`, "INVALID_AVATAR_RANGE");
  }
  positiveNumber(track.width, `${track.id}.width`);
  positiveNumber(track.height, `${track.id}.height`);
}

function validateCallout(track) {
  if (!isNonEmptyString(track.text)) {
    throw new VideoTimelineError(`Callout track ${track.id} is missing text.`, "MISSING_CALLOUT_TEXT");
  }
  const start = finiteNumber(track.timelineStart, 0, `${track.id}.timelineStart`);
  const end = finiteNumber(track.timelineEnd, null, `${track.id}.timelineEnd`);
  if (end <= start) {
    throw new VideoTimelineError(`Callout track ${track.id} timelineEnd must be greater than timelineStart.`, "INVALID_CALLOUT_RANGE");
  }
  finiteNumber(track.x, 0, `${track.id}.x`);
  finiteNumber(track.y, 0, `${track.id}.y`);
  positiveNumber(track.fontSize, `${track.id}.fontSize`);
}

function validateZoom(track) {
  const start = finiteNumber(track.timelineStart, 0, `${track.id}.timelineStart`);
  const end = finiteNumber(track.timelineEnd, null, `${track.id}.timelineEnd`);
  if (end <= start) {
    throw new VideoTimelineError(`Zoom track ${track.id} timelineEnd must be greater than timelineStart.`, "INVALID_ZOOM_RANGE");
  }
  scaleAtLeastOne(track.startScale ?? 1, `${track.id}.startScale`);
  scaleAtLeastOne(track.endScale ?? 1.18, `${track.id}.endScale`);
}

function normalizeCanvas(canvas = {}) {
  const resolved = { ...DEFAULT_CANVAS, ...(canvas ?? {}) };
  return {
    width: positiveNumber(resolved.width, "canvas.width"),
    height: positiveNumber(resolved.height, "canvas.height"),
    fps: positiveNumber(resolved.fps, "canvas.fps"),
    audioSampleRate: positiveNumber(resolved.audioSampleRate, "canvas.audioSampleRate"),
    videoCodec: resolved.videoCodec || DEFAULT_CANVAS.videoCodec,
    audioCodec: resolved.audioCodec || DEFAULT_CANVAS.audioCodec
  };
}

function baseVideoFilter(canvas) {
  return [
    `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease`,
    `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${canvas.fps}`
  ].join(",");
}

function avatarPosition(track, canvas) {
  if (track.position === "bottom-right") {
    return {
      x: canvas.width - Number(track.width) - Number(track.marginRight ?? 40),
      y: canvas.height - Number(track.height) - Number(track.marginBottom ?? 40)
    };
  }
  return {
    x: Number(track.x ?? canvas.width - Number(track.width) - 40),
    y: Number(track.y ?? canvas.height - Number(track.height) - 40)
  };
}

function silentAudioInput(sampleRate) {
  return [
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`
  ];
}

async function hasAudioStream(inputPath, options = {}) {
  const output = await runCommandCapture(options.ffprobePath ?? "ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    inputPath
  ], { commandName: "FFprobe" });
  return output.trim().length > 0;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
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
      reject(new VideoTimelineError(`${options.commandName ?? command} failed with exit code ${code}: ${lastLines(stderr)}`, "COMMAND_FAILED"));
    });
  });
}

async function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
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
      reject(new VideoTimelineError(`${options.commandName ?? command} failed with exit code ${code}: ${lastLines(stderr)}`, "COMMAND_FAILED"));
    });
  });
}

function resolvePath(filePath, baseDir, options = {}) {
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath);
  if (options.allowedRoot && !isPathInsideOrEqual(path.resolve(options.allowedRoot), resolved)) {
    throw new VideoTimelineError(`Path is outside allowed project storage: ${filePath}`, "PATH_OUTSIDE_ALLOWED_ROOT");
  }
  return resolved;
}

function isPathInsideOrEqual(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function positiveNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new VideoTimelineError(`${label} must be a positive number.`, "INVALID_NUMBER");
  }
  return numeric;
}

function scaleAtLeastOne(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    throw new VideoTimelineError(`${label} must be greater than or equal to 1.`, "INVALID_NUMBER");
  }
  return numeric;
}

function finiteNumber(value, fallback, label) {
  const candidate = value === undefined || value === null ? fallback : value;
  const numeric = Number(candidate);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new VideoTimelineError(`${label} must be a non-negative number.`, "INVALID_NUMBER");
  }
  return numeric;
}

function ffmpegColor(value) {
  const normalized = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return `0x${normalized.slice(1)}`;
  }
  return normalized || "white";
}

function buildZoomExpression(tracks, fps) {
  return [...tracks]
    .sort((left, right) => Number(left.timelineStart) - Number(right.timelineStart))
    .reduce((expression, track) => {
      const start = Number(track.timelineStart);
      const end = Number(track.timelineEnd);
      const duration = Math.max(0.001, end - start);
      const startScale = Number(track.startScale ?? 1);
      const endScale = Number(track.endScale ?? (track.mode === "out" ? 1 : 1.18));
      const progress = `((on/${fps}-${start})/${duration})`;
      const zoomValue = `${startScale}+(${endScale - startScale})*${progress}`;
      return `if(between(on/${fps}\\,${start}\\,${end})\\,${zoomValue}\\,${expression})`;
    }, "1");
}

function escapeDrawtext(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

async function drawtextFontOption(options = {}) {
  const fontFile = options.fontFile ?? await findDefaultFontFile();
  if (!fontFile) return "";
  return `fontfile='${escapeDrawtextPath(fontFile)}':`;
}

async function findDefaultFontFile() {
  const candidates = process.platform === "win32"
    ? [
      "C:/Windows/Fonts/segoeui.ttf",
      "C:/Windows/Fonts/arial.ttf",
      "C:/Windows/Fonts/calibri.ttf"
    ]
    : process.platform === "darwin"
      ? [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttf"
      ]
      : [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"
      ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function escapeDrawtextPath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function escapeConcatPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function sanitizePathSegment(value) {
  return String(value ?? "project")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
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
    return new VideoTimelineError(`${options.commandName ?? command} is not installed or not available in PATH.`, "COMMAND_NOT_FOUND", error);
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new VideoTimelineError(`${options.commandName ?? command} could not be executed: ${error.message}`, "COMMAND_NOT_EXECUTABLE", error);
  }
  return error;
}
