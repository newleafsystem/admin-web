import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadObject, uploadObject } from './storage.js';

const DEFAULT_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

export async function renderTimelineJob({ payload, storage }) {
  validatePayload(payload);
  await assertFfmpegAvailable();

  const workDir = join(tmpdir(), `newleaf-render-${sanitizeName(payload.renderJobId)}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    const assetMap = await downloadAssets({ payload, storage, workDir });
    const normalizedClips = await normalizeVideoClips({ payload, assetMap, workDir });
    const concatPath = await createConcatFile({ normalizedClips, workDir });
    const baseVideoPath = join(workDir, 'base-video.mp4');
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', baseVideoPath]);

    const audioPath = await renderAudioTrack({ payload, assetMap, workDir, durationSec: calculateDuration(payload.timeline) });
    const withAudioPath = join(workDir, 'with-audio.mp4');
    await muxAudio({ videoPath: baseVideoPath, audioPath, outputPath: withAudioPath, durationSec: calculateDuration(payload.timeline) });

    const finalPath = join(workDir, 'output.mp4');
    await applyTextOverlays({ payload, inputPath: withAudioPath, outputPath: finalPath });
    const outputKey = getOutputKey(payload);
    await uploadObject({
      storage,
      key: outputKey,
      sourcePath: finalPath,
      contentType: 'video/mp4',
    });

    return {
      ok: true,
      status: 'completed',
      mode: 'google-cloud-run',
      renderJobId: payload.renderJobId,
      projectId: payload.projectId,
      outputObjectKey: outputKey,
    };
  } finally {
    if (process.env.KEEP_RENDER_TEMP !== 'true') {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function downloadAssets({ payload, storage, workDir }) {
  const assetMap = new Map();
  for (const asset of payload.assets ?? []) {
    const objectKey = getAssetKey(asset);
    if (!asset?.id || !objectKey) continue;
    const extension = extname(objectKey) || extensionForMimeType(asset.mimeType);
    const localPath = join(workDir, 'assets', `${sanitizeName(asset.id)}${extension}`);
    await downloadObject({
      storage,
      key: objectKey,
      destinationPath: localPath,
    });
    assetMap.set(asset.id, { ...asset, objectKey, localPath });
  }
  return assetMap;
}

async function normalizeVideoClips({ payload, assetMap, workDir }) {
  const videoClips = (payload.timeline.tracks ?? [])
    .filter((track) => track.type === 'video')
    .flatMap((track) => track.clips ?? [])
    .sort((left, right) => Number(left.timelineStart ?? 0) - Number(right.timelineStart ?? 0));

  if (videoClips.length === 0) {
    throw new Error('Timeline does not contain video clips');
  }

  const settings = {
    width: Number(payload.timeline.resolution?.width ?? 1920),
    height: Number(payload.timeline.resolution?.height ?? 1080),
    fps: Number(payload.timeline.fps ?? 30),
  };
  const normalizedClips = [];

  for (const [index, clip] of videoClips.entries()) {
    const asset = assetMap.get(clip.assetId);
    if (!asset) {
      throw new Error(`Missing downloaded asset for clip: ${clip.assetId}`);
    }
    const outputPath = join(workDir, 'clips', `${String(index + 1).padStart(3, '0')}-${sanitizeName(clip.assetId)}.mp4`);
    await mkdir(join(workDir, 'clips'), { recursive: true });
    await runFfmpeg([
      '-y',
      '-ss', String(clip.start),
      '-to', String(clip.end),
      '-i', asset.localPath,
      '-vf', `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2,fps=${settings.fps}`,
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      outputPath,
    ]);
    normalizedClips.push(outputPath);
  }

  return normalizedClips;
}

async function createConcatFile({ normalizedClips, workDir }) {
  const concatPath = join(workDir, 'concat.txt');
  const lines = normalizedClips.map((clipPath) => `file '${escapeConcatPath(clipPath)}'`);
  await writeFile(concatPath, `${lines.join('\n')}\n`, 'utf8');
  return concatPath;
}

async function renderAudioTrack({ payload, assetMap, workDir, durationSec }) {
  const audioClip = (payload.timeline.tracks ?? [])
    .filter((track) => track.type === 'audio')
    .flatMap((track) => track.clips ?? [])
    .sort((left, right) => Number(left.timelineStart ?? 0) - Number(right.timelineStart ?? 0))[0];

  const outputPath = join(workDir, 'audio.m4a');
  if (!audioClip) {
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', String(Math.max(0.1, durationSec)),
      '-c:a', 'aac',
      '-ar', '48000',
      outputPath,
    ]);
    return outputPath;
  }

  const asset = assetMap.get(audioClip.assetId);
  if (!asset) {
    throw new Error(`Missing downloaded audio asset: ${audioClip.assetId}`);
  }
  await runFfmpeg([
    '-y',
    '-ss', String(audioClip.start),
    '-to', String(audioClip.end),
    '-i', asset.localPath,
    '-vn',
    '-c:a', 'aac',
    '-ar', '48000',
    '-filter:a', `volume=${Number(audioClip.volume ?? 1)}`,
    outputPath,
  ]);
  return outputPath;
}

async function muxAudio({ videoPath, audioPath, outputPath }) {
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '48000',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

async function applyTextOverlays({ payload, inputPath, outputPath }) {
  const overlays = (payload.timeline.overlays ?? []).filter((overlay) => overlay.type === 'text' && overlay.text);
  if (overlays.length === 0) {
    await runFfmpeg(['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outputPath]);
    return;
  }

  const filter = overlays.map((overlay) => {
    const x = overlay.x === 'center' ? '(w-text_w)/2' : overlay.x === 'right' ? 'w-text_w-80' : overlay.x === 'left' ? '80' : String(Number(overlay.x) || 80);
    const y = overlay.y === 'bottom' ? 'h-text_h-80' : overlay.y === 'top' ? '80' : overlay.y === 'center' ? '(h-text_h)/2' : String(Number(overlay.y) || 80);
    return [
      `drawtext=fontfile=${DEFAULT_FONT}`,
      `text='${escapeDrawText(overlay.text)}'`,
      `x=${x}`,
      `y=${y}`,
      'fontsize=48',
      'fontcolor=white',
      'box=1',
      'boxcolor=black@0.62',
      'boxborderw=24',
      `enable='between(t,${Number(overlay.start)},${Number(overlay.end)})'`,
    ].join(':');
  }).join(',');

  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

async function assertFfmpegAvailable() {
  await runProcess('ffmpeg', ['-version']);
}

async function runFfmpeg(args) {
  await runProcess('ffmpeg', args);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (error) => reject(new Error(`${command} failed to start: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Render payload must be an object');
  for (const field of ['renderJobId', 'projectId', 'timeline']) {
    if (!payload[field]) throw new Error(`Render payload missing ${field}`);
  }
  if (!getOutputKey(payload)) {
    throw new Error('Render payload missing outputObjectKey');
  }
  if (!Array.isArray(payload.assets)) throw new Error('Render payload assets must be an array');
}

function getOutputKey(payload) {
  return payload.outputObjectKey ?? payload.outputGcsKey ?? payload.outputR2Key ?? null;
}

function getAssetKey(asset) {
  return asset?.objectKey ?? asset?.gcsKey ?? asset?.r2Key ?? null;
}

function calculateDuration(timeline) {
  const clipEnd = (timeline.tracks ?? [])
    .flatMap((track) => track.clips ?? [])
    .reduce((max, clip) => Math.max(max, Number(clip.timelineStart ?? 0) + Math.max(0, Number(clip.end) - Number(clip.start ?? 0))), 0);
  const overlayEnd = (timeline.overlays ?? [])
    .reduce((max, overlay) => Math.max(max, Number(overlay.end ?? 0)), 0);
  return Math.max(0.1, clipEnd, overlayEnd);
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType ?? '').toLowerCase();
  if (normalized.includes('quicktime')) return '.mov';
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('mpeg')) return '.mp3';
  if (normalized.includes('wav')) return '.wav';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('jpeg')) return '.jpg';
  return '.mp4';
}

function escapeConcatPath(value) {
  return String(value).replaceAll("'", "'\\''");
}

function escapeDrawText(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('%', '\\%')
    .slice(0, 500);
}

function sanitizeName(value) {
  return basename(String(value ?? 'asset')).replace(/[^\w.-]+/g, '_').slice(0, 120) || 'asset';
}
