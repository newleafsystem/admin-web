import fsp from 'node:fs/promises';
import path from 'node:path';
import { renderTimeline, validateTimeline, VideoTimelineError } from '@newleaf/video-assembler';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/httpErrors.js';

const DEFAULT_CANVAS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  audioSampleRate: 48000,
  videoCodec: 'libx264',
  audioCodec: 'aac',
});

const ASSET_TYPES = new Set(['screen-video', 'voiceover', 'avatar']);

export function createVideoStudioService(options = {}) {
  const serviceConfig = options.config ?? config;
  const rootDir = path.resolve(process.cwd(), serviceConfig.localDataDir, 'video-projects');
  const clock = options.clock ?? (() => new Date().toISOString());

  async function createProject({ projectId, title, actorUid = 'local-admin' }) {
    const safeProjectId = sanitizeProjectId(projectId || title || `video-studio-${Date.now()}`);
    const projectDir = getProjectDir(safeProjectId);
    const timelinePath = getTimelinePath(safeProjectId);

    await fsp.mkdir(projectDir, { recursive: true });
    if (await pathExists(timelinePath)) {
      return readProject(safeProjectId);
    }

    const timeline = createTimelineShell({
      projectId: safeProjectId,
      title: title || safeProjectId,
    });
    await writeTimeline(safeProjectId, timeline);
    await writeStatus(safeProjectId, {
      status: 'draft',
      message: 'Video Studio project created.',
      createdBy: actorUid,
      updatedAt: clock(),
    });
    return readProject(safeProjectId);
  }

  async function readProject(projectId) {
    const safeProjectId = sanitizeProjectId(projectId);
    const timeline = await readTimeline(safeProjectId);
    const status = await readStatus(safeProjectId);
    return {
      project: {
        projectId: safeProjectId,
        title: timeline.title,
      },
      timeline,
      status,
      assets: collectAssetSummaries(safeProjectId, timeline),
      output: outputSummary(safeProjectId, timeline),
    };
  }

  async function readTimeline(projectId) {
    const safeProjectId = sanitizeProjectId(projectId);
    const timelinePath = getTimelinePath(safeProjectId);
    if (!(await pathExists(timelinePath))) {
      throw notFound('Video project timeline not found', { projectId: safeProjectId });
    }
    return JSON.parse(await fsp.readFile(timelinePath, 'utf8'));
  }

  async function updateTimeline(projectId, timeline) {
    const safeProjectId = sanitizeProjectId(projectId);
    const normalized = {
      ...timeline,
      projectId: safeProjectId,
      output: timeline.output || 'output/final.mp4',
      canvas: {
        ...DEFAULT_CANVAS,
        ...(timeline.canvas ?? {}),
      },
      tracks: Array.isArray(timeline.tracks) ? timeline.tracks.map(stripUiOnlyTrackFields) : [],
    };
    await validateTimeline(normalized, {
      baseDir: getProjectDir(safeProjectId),
      allowedRoot: getProjectDir(safeProjectId),
      checkFiles: false,
    });
    await clearRenderedFiles(safeProjectId);
    await writeTimeline(safeProjectId, normalized);
    await writeStatus(safeProjectId, {
      ...(await readStatus(safeProjectId)),
      status: 'draft',
      message: 'Timeline updated.',
      updatedAt: clock(),
    });
    return readProject(safeProjectId);
  }

  async function uploadAsset(projectId, { type, buffer, filename, mimeType, actorUid = 'local-admin' }) {
    const safeProjectId = sanitizeProjectId(projectId);
    if (!ASSET_TYPES.has(type)) {
      throw badRequest('Unsupported Video Studio asset type', { type, allowed: Array.from(ASSET_TYPES) });
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw badRequest('Upload body must contain file bytes');
    }

    const timeline = await readTimeline(safeProjectId);
    const safeFilename = sanitizeFilename(filename || defaultFilenameForType(type));
    const storageKey = path.join('uploads', `${Date.now()}-${safeFilename}`).replace(/\\/g, '/');
    const destination = resolveProjectPath(safeProjectId, storageKey);

    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, buffer);
    await clearRenderedFiles(safeProjectId);

    const updatedTimeline = updateTimelineForAsset(timeline, {
      type,
      source: storageKey,
      filename: safeFilename,
      mimeType,
    });
    await writeTimeline(safeProjectId, updatedTimeline);
    await writeStatus(safeProjectId, {
      ...(await readStatus(safeProjectId)),
      status: 'draft',
      message: `${type} uploaded.`,
      updatedAt: clock(),
      updatedBy: actorUid,
    });

    return {
      ...(await readProject(safeProjectId)),
      uploaded: {
        type,
        source: storageKey,
        filename: safeFilename,
        mimeType,
        sizeBytes: buffer.length,
      },
    };
  }

  async function deleteAsset(projectId, { trackId, actorUid = 'local-admin' }) {
    const safeProjectId = sanitizeProjectId(projectId);
    const safeTrackId = String(trackId ?? '').trim();
    if (!safeTrackId) {
      throw badRequest('trackId is required');
    }

    const timeline = await readTimeline(safeProjectId);
    const track = (timeline.tracks ?? []).find((candidate) => candidate.id === safeTrackId);
    if (!track) {
      throw notFound('Video Studio asset not found', { projectId: safeProjectId, trackId: safeTrackId });
    }

    if (track.source) {
      const source = String(track.source).replace(/^\/+/, '');
      if (!source.startsWith('uploads/')) {
        throw badRequest('Only uploaded project assets can be deleted');
      }
      await fsp.rm(resolveProjectPath(safeProjectId, source), { force: true });
    }

    const updatedTimeline = {
      ...timeline,
      tracks: (timeline.tracks ?? []).filter((candidate) => candidate.id !== safeTrackId),
    };
    await clearRenderedFiles(safeProjectId);
    await writeTimeline(safeProjectId, updatedTimeline);
    await writeStatus(safeProjectId, {
      ...(await readStatus(safeProjectId)),
      status: 'draft',
      message: `${safeTrackId} deleted.`,
      updatedAt: clock(),
      updatedBy: actorUid,
    });
    return {
      ...(await readProject(safeProjectId)),
      deleted: {
        trackId: safeTrackId,
        source: track.source ?? null,
      },
    };
  }

  async function deleteProject(projectId, { actorUid = 'local-admin' } = {}) {
    const safeProjectId = sanitizeProjectId(projectId);
    const projectDir = getProjectDir(safeProjectId);
    if (!(await pathExists(projectDir))) {
      throw notFound('Video Studio project not found', { projectId: safeProjectId });
    }
    await fsp.rm(projectDir, { recursive: true, force: true });
    return {
      deleted: true,
      projectId: safeProjectId,
      deletedBy: actorUid,
      deletedAt: clock(),
    };
  }

  async function renderProject(projectId, { actorUid = 'local-admin' } = {}) {
    const safeProjectId = sanitizeProjectId(projectId);
    const projectDir = getProjectDir(safeProjectId);
    const timelinePath = getTimelinePath(safeProjectId);
    if (!(await pathExists(timelinePath))) {
      throw notFound('Video project timeline not found', { projectId: safeProjectId });
    }

    await writeStatus(safeProjectId, {
      status: 'rendering',
      message: 'Rendering timeline with FFmpeg.',
      renderStartedAt: clock(),
      updatedAt: clock(),
      updatedBy: actorUid,
    });

    try {
      const result = await renderTimeline(timelinePath, {
        baseDir: projectDir,
        allowedRoot: projectDir,
        tempDir: path.join(projectDir, 'temp'),
        ffmpegPath: serviceConfig.videoAssembler?.ffmpegPath ?? undefined,
        ffprobePath: serviceConfig.videoAssembler?.ffprobePath ?? undefined,
        fontFile: serviceConfig.videoAssembler?.fontFile ?? undefined,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      await writeStatus(safeProjectId, {
        status: 'rendered',
        message: 'Final MP4 rendered.',
        outputPath: result.outputPath,
        duration: result.duration,
        renderStartedAt: (await readStatus(safeProjectId)).renderStartedAt ?? null,
        renderCompletedAt: clock(),
        updatedAt: clock(),
        updatedBy: actorUid,
      });
      return readProject(safeProjectId);
    } catch (error) {
      const message = renderErrorMessage(error);
      await writeStatus(safeProjectId, {
        status: 'failed',
        message,
        errorCode: error.code ?? 'render_failed',
        updatedAt: clock(),
        updatedBy: actorUid,
      });
      if (error instanceof VideoTimelineError) {
        throw badRequest(message, { code: error.code ?? 'render_failed' });
      }
      throw error;
    }
  }

  function createAssetReadStream(projectId, assetPath) {
    const safeProjectId = sanitizeProjectId(projectId);
    const relativePath = String(assetPath ?? '').replace(/^\/+/, '');
    if (!relativePath.startsWith('uploads/')) {
      throw badRequest('Only uploaded project assets can be streamed');
    }
    const filePath = resolveProjectPath(safeProjectId, relativePath);
    return {
      filePath,
    };
  }

  function getOutputPath(projectId, output = 'output/final.mp4') {
    const safeProjectId = sanitizeProjectId(projectId);
    return resolveProjectPath(safeProjectId, output);
  }

  return {
    createAssetReadStream,
    createProject,
    deleteAsset,
    deleteProject,
    getOutputPath,
    readProject,
    readTimeline,
    renderProject,
    updateTimeline,
    uploadAsset,
  };

  async function writeTimeline(projectId, timeline) {
    const safeProjectId = sanitizeProjectId(projectId);
    const timelinePath = getTimelinePath(safeProjectId);
    await fsp.mkdir(path.dirname(timelinePath), { recursive: true });
    await fsp.writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, 'utf8');
  }

  async function readStatus(projectId) {
    const statusPath = getStatusPath(projectId);
    if (!(await pathExists(statusPath))) {
      return {
        status: 'draft',
        message: 'Timeline is editable.',
        updatedAt: null,
      };
    }
    return JSON.parse(await fsp.readFile(statusPath, 'utf8'));
  }

  async function writeStatus(projectId, status) {
    const statusPath = getStatusPath(projectId);
    await fsp.mkdir(path.dirname(statusPath), { recursive: true });
    await fsp.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }

  function getTimelinePath(projectId) {
    return path.join(getProjectDir(projectId), 'timeline.json');
  }

  function getStatusPath(projectId) {
    return path.join(getProjectDir(projectId), 'status.json');
  }

  function getProjectDir(projectId) {
    const safeProjectId = sanitizeProjectId(projectId);
    const projectDir = path.resolve(rootDir, safeProjectId);
    if (!isPathInsideOrEqual(rootDir, projectDir)) {
      throw badRequest('Invalid project path');
    }
    return projectDir;
  }

  function resolveProjectPath(projectId, relativePath) {
    const projectDir = getProjectDir(projectId);
    const filePath = path.resolve(projectDir, relativePath);
    if (!isPathInsideOrEqual(projectDir, filePath)) {
      throw badRequest('Invalid project file path');
    }
    return filePath;
  }

  async function clearRenderedFiles(projectId) {
    await fsp.rm(resolveProjectPath(projectId, 'output'), { recursive: true, force: true });
    await fsp.rm(resolveProjectPath(projectId, 'temp'), { recursive: true, force: true });
  }
}

function createTimelineShell({ projectId, title }) {
  return {
    projectId,
    title,
    output: 'output/final.mp4',
    canvas: DEFAULT_CANVAS,
    tracks: [],
  };
}

function updateTimelineForAsset(timeline, asset) {
  if (asset.type === 'screen-video') {
    return upsertTrack(timeline, {
      id: 'screen-video',
      type: 'video',
      source: asset.source,
      muted: true,
      clips: [
        {
          sourceStart: 0,
          sourceEnd: 10,
          timelineStart: 0,
        },
      ],
    });
  }

  if (asset.type === 'voiceover') {
    return upsertTrack(timeline, {
      id: 'voiceover',
      type: 'audio',
      source: asset.source,
      timelineStart: 0,
      volume: 1,
    });
  }

  return upsertTrack(timeline, {
    id: 'avatar-pip',
    type: 'avatar',
    source: asset.source,
    timelineStart: 5,
    sourceStart: 0,
    sourceEnd: 5,
    position: 'bottom-right',
    width: 340,
    height: 340,
    marginRight: 40,
    marginBottom: 40,
    borderColor: '#C9A96E',
    borderRadius: 24,
  });
}

function stripUiOnlyTrackFields(track) {
  const { sourceUrl, ...rest } = track;
  return rest;
}

function renderErrorMessage(error) {
  const message = String(error?.message ?? 'Unable to render timeline.');
  const fontconfigIndex = message.indexOf('Fontconfig error:');
  if (fontconfigIndex >= 0) {
    return `${message.slice(fontconfigIndex).trim()} Configure FFMPEG_FONT_FILE or make sure a system font is available.`;
  }
  if (message.length <= 1000) {
    return message;
  }
  return message.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
}

function upsertTrack(timeline, track) {
  const tracks = Array.isArray(timeline.tracks) ? [...timeline.tracks] : [];
  const index = tracks.findIndex((candidate) => candidate.id === track.id);
  if (index >= 0) {
    tracks[index] = {
      ...tracks[index],
      ...track,
    };
  } else {
    tracks.push(track);
  }
  return {
    ...timeline,
    tracks,
  };
}

function collectAssetSummaries(projectId, timeline) {
  return (timeline.tracks ?? [])
    .filter((track) => track.source)
    .map((track) => ({
      id: track.id,
      type: track.type,
      source: track.source,
      url: `/api/v1/video-projects/${encodeURIComponent(projectId)}/assets/${track.source.split('/').map(encodeURIComponent).join('/')}`,
    }));
}

function outputSummary(projectId, timeline) {
  return {
    path: timeline.output,
    url: `/api/v1/video-projects/${encodeURIComponent(projectId)}/output`,
  };
}

function defaultFilenameForType(type) {
  if (type === 'voiceover') return 'voiceover.mp3';
  if (type === 'avatar') return 'avatar.mp4';
  return 'screen-recording.mp4';
}

function sanitizeProjectId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const safe = text.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe) {
    throw badRequest('projectId is required');
  }
  return safe.slice(0, 120);
}

function sanitizeFilename(value) {
  const filename = path.basename(String(value ?? '')).replace(/[^\w.\- ]+/g, '_').trim();
  return filename || 'upload.bin';
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isPathInsideOrEqual(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
