import { useMemo, useState } from "react";
import {
  createVideoStudioProject,
  deleteVideoStudioAsset,
  deleteVideoStudioProject,
  renderVideoStudioProject,
  updateVideoStudioTimeline,
  uploadVideoStudioAsset
} from "../api.js";
import { ModalShell } from "../components/common.jsx";

const DEFAULT_FORM = {
  projectId: "newleaf-homepage-demo",
  title: "NewLeaf Homepage Demo",
  clips: [
    {
      sourceStart: 0,
      sourceEnd: 10
    }
  ],
  muted: true,
  zoomEnabled: false,
  zoomMode: "in",
  zoomStart: 1,
  zoomEnd: 6,
  zoomScale: 1.18,
  avatarStart: 5,
  calloutText: "One connected trading workflow",
  calloutStart: 6,
  calloutEnd: 10
};

export function VideoStudio() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [projectState, setProjectState] = useState(null);
  const [workflow, setWorkflow] = useState({
    isCreating: false,
    isUploading: false,
    isSaving: false,
    isRendering: false,
    isDeleting: false,
    error: null,
    message: null
  });
  const [deleteConfirmation, setDeleteConfirmation] = useState(null);

  const timeline = projectState?.timeline ?? null;
  const screenTrack = useMemo(() => timeline?.tracks?.find((track) => track.type === "video") ?? null, [timeline]);
  const voiceoverTrack = useMemo(() => timeline?.tracks?.find((track) => track.type === "audio") ?? null, [timeline]);
  const avatarTrack = useMemo(() => timeline?.tracks?.find((track) => track.type === "avatar") ?? null, [timeline]);
  const zoomTrack = useMemo(() => timeline?.tracks?.find((track) => track.type === "zoom") ?? null, [timeline]);
  const outputUrl = projectState?.status?.status === "rendered" && projectState?.output?.url
    ? `${projectState.output.url}?v=${encodeURIComponent(projectState.status.renderCompletedAt ?? projectState.status.updatedAt ?? "")}`
    : null;

  async function createProject(event) {
    event.preventDefault();
    setWorkflowState({ isCreating: true, error: null, message: null });
    try {
      const result = await createVideoStudioProject({
        projectId: form.projectId,
        title: form.title
      });
      setProjectState(result);
      hydrateFormFromTimeline(result.timeline);
      setWorkflowState({ isCreating: false, message: "Project ready." });
    } catch (error) {
      setWorkflowState({ isCreating: false, error: error.message });
    }
  }

  async function uploadAsset(type, file) {
    if (!file || !projectState?.project?.projectId) return;
    setWorkflowState({ isUploading: true, error: null, message: null });
    try {
      const result = await uploadVideoStudioAsset(projectState.project.projectId, type, file);
      setProjectState(result);
      hydrateFormFromTimeline(result.timeline);
      setWorkflowState({ isUploading: false, message: `${assetLabel(type)} uploaded.` });
    } catch (error) {
      setWorkflowState({ isUploading: false, error: error.message });
    }
  }

  async function saveTimeline() {
    if (!projectState?.project?.projectId || !timeline) return;
    setWorkflowState({ isSaving: true, error: null, message: null });
    try {
      const nextTimeline = timelineFromForm(timeline, form);
      const result = await updateVideoStudioTimeline(projectState.project.projectId, nextTimeline);
      setProjectState(result);
      setWorkflowState({ isSaving: false, message: "Timeline saved." });
    } catch (error) {
      setWorkflowState({ isSaving: false, error: error.message });
    }
  }

  async function renderProject() {
    if (!projectState?.project?.projectId) return;
    setWorkflowState({ isRendering: true, error: null, message: null });
    try {
      const saved = await updateVideoStudioTimeline(projectState.project.projectId, timelineFromForm(timeline, form));
      setProjectState(saved);
      const result = await renderVideoStudioProject(projectState.project.projectId);
      setProjectState(result);
      setWorkflowState({ isRendering: false, message: "Final MP4 rendered." });
    } catch (error) {
      setWorkflowState({ isRendering: false, error: error.message });
    }
  }

  function hydrateFormFromTimeline(nextTimeline) {
    const nextScreen = nextTimeline?.tracks?.find((track) => track.type === "video");
    const nextAvatar = nextTimeline?.tracks?.find((track) => track.type === "avatar");
    const nextCallout = nextTimeline?.tracks?.find((track) => track.type === "callout");
    const nextZoom = nextTimeline?.tracks?.find((track) => track.type === "zoom");
    const zoomMode = nextZoom?.mode ?? (Number(nextZoom?.startScale ?? 1) > Number(nextZoom?.endScale ?? 1) ? "out" : "in");
    setForm((current) => ({
      ...current,
      title: nextTimeline?.title ?? current.title,
      clips: nextScreen?.clips?.length
        ? nextScreen.clips.map((clip) => ({
          sourceStart: clip.sourceStart ?? 0,
          sourceEnd: clip.sourceEnd ?? 10
        }))
        : current.clips,
      muted: nextScreen?.muted ?? current.muted,
      zoomEnabled: Boolean(nextZoom),
      zoomMode,
      zoomStart: nextZoom?.timelineStart ?? current.zoomStart,
      zoomEnd: nextZoom?.timelineEnd ?? current.zoomEnd,
      zoomScale: Math.max(Number(nextZoom?.startScale ?? current.zoomScale), Number(nextZoom?.endScale ?? current.zoomScale)),
      avatarStart: nextAvatar?.timelineStart ?? current.avatarStart,
      calloutText: nextCallout?.text ?? current.calloutText,
      calloutStart: nextCallout?.timelineStart ?? current.calloutStart,
      calloutEnd: nextCallout?.timelineEnd ?? current.calloutEnd
    }));
  }

  function updateForm(patch) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function updateClip(index, patch) {
    setForm((current) => ({
      ...current,
      clips: current.clips.map((clip, clipIndex) => (clipIndex === index ? { ...clip, ...patch } : clip))
    }));
  }

  function addClip() {
    setForm((current) => {
      const lastClip = current.clips[current.clips.length - 1] ?? { sourceEnd: 0 };
      const start = Number(lastClip.sourceEnd ?? 0);
      return {
        ...current,
        clips: [
          ...current.clips,
          {
            sourceStart: start,
            sourceEnd: start + 5
          }
        ]
      };
    });
  }

  function removeClip(index) {
    setForm((current) => ({
      ...current,
      clips: current.clips.filter((clip, clipIndex) => clipIndex !== index)
    }));
  }

  function requestDeleteProject() {
    if (!projectState?.project?.projectId) return;
    setDeleteConfirmation({
      scope: "project",
      title: "Delete Video Studio project",
      detail: projectState.project.projectId
    });
  }

  function requestDeleteAsset(track, label) {
    if (!track) return;
    setDeleteConfirmation({
      scope: "asset",
      trackId: track.id,
      title: `Delete ${label}`,
      detail: track.source ?? track.id
    });
  }

  async function confirmDelete() {
    if (!deleteConfirmation || !projectState?.project?.projectId) return;
    setWorkflowState({ isDeleting: true, error: null, message: null });
    try {
      if (deleteConfirmation.scope === "project") {
        await deleteVideoStudioProject(projectState.project.projectId);
        setProjectState(null);
        setDeleteConfirmation(null);
        setWorkflowState({ isDeleting: false, message: "Video Studio project deleted." });
        return;
      }

      const result = await deleteVideoStudioAsset(projectState.project.projectId, deleteConfirmation.trackId);
      setProjectState(result);
      hydrateFormFromTimeline(result.timeline);
      setDeleteConfirmation(null);
      setWorkflowState({ isDeleting: false, message: "Uploaded asset deleted." });
    } catch (error) {
      setWorkflowState({ isDeleting: false, error: error.message });
    }
  }

  function setWorkflowState(patch) {
    setWorkflow((current) => ({
      ...current,
      ...patch
    }));
  }

  const isBusy = workflow.isCreating || workflow.isUploading || workflow.isSaving || workflow.isRendering || workflow.isDeleting;
  const canEditTimeline = Boolean(projectState?.project?.projectId && screenTrack);

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Video Studio MVP</h2>
            <span className="muted">Timeline-based walkthrough editor rendered by FFmpeg.</span>
          </div>
          <div className="modal-header-actions">
            {projectState?.status?.status && <span className="status-pill">{projectState.status.status}</span>}
            {projectState?.project?.projectId && (
              <button className="danger" type="button" disabled={isBusy} onClick={requestDeleteProject}>
                Delete project
              </button>
            )}
          </div>
        </div>

        <form className="studio-create-form" onSubmit={createProject}>
          <label>
            Project ID
            <input
              value={form.projectId}
              disabled={isBusy}
              onChange={(event) => updateForm({ projectId: event.target.value })}
            />
          </label>
          <label>
            Title
            <input
              value={form.title}
              disabled={isBusy}
              onChange={(event) => updateForm({ title: event.target.value })}
            />
          </label>
          <button className="primary" type="submit" disabled={isBusy || !form.title.trim()}>
            {workflow.isCreating ? "Creating..." : "Create / Load"}
          </button>
        </form>
      </section>

      {projectState && (
        <section className="panel video-studio-grid">
          <div className="studio-preview">
            <h3>Preview</h3>
            {screenTrack?.sourceUrl ? (
              <video controls src={screenTrack.sourceUrl} />
            ) : (
              <div className="empty-inline">Upload a screen recording to start editing.</div>
            )}
            <div className="studio-upload-row">
              <FileUploadButton
                disabled={isBusy}
                label={screenTrack ? "Replace screen video" : "Upload screen video"}
                accept="video/mp4,video/quicktime,video/webm"
                onFile={(file) => uploadAsset("screen-video", file)}
              />
              <FileUploadButton
                disabled={isBusy}
                label={voiceoverTrack ? "Replace voiceover" : "Upload voiceover"}
                accept="audio/mpeg,audio/mp4,audio/wav"
                onFile={(file) => uploadAsset("voiceover", file)}
              />
              <FileUploadButton
                disabled={isBusy}
                label={avatarTrack ? "Replace avatar PIP" : "Upload avatar PIP"}
                accept="video/mp4,video/quicktime,video/webm"
                onFile={(file) => uploadAsset("avatar", file)}
              />
            </div>
            <div className="studio-asset-list">
              {screenTrack && (
                <AssetRow label="Screen video" track={screenTrack} disabled={isBusy} onDelete={requestDeleteAsset} />
              )}
              {voiceoverTrack && (
                <AssetRow label="Voiceover" track={voiceoverTrack} disabled={isBusy} onDelete={requestDeleteAsset} />
              )}
              {avatarTrack && (
                <AssetRow label="Avatar PIP" track={avatarTrack} disabled={isBusy} onDelete={requestDeleteAsset} />
              )}
            </div>
          </div>

          <div className="studio-controls">
            <h3>Timeline</h3>
            <div className="studio-control-grid">
              <div className="studio-clip-list">
                <div className="section-title-row">
                  <h4>Kept sections</h4>
                  <button type="button" disabled={!canEditTimeline || isBusy} onClick={addClip}>
                    Add section
                  </button>
                </div>
                {form.clips.map((clip, index) => (
                  <div className="studio-clip-row" key={`clip-${index}`}>
                    <label>
                      Start
                      <input
                        min="0"
                        step="0.1"
                        type="number"
                        value={clip.sourceStart}
                        disabled={!canEditTimeline || isBusy}
                        onChange={(event) => updateClip(index, { sourceStart: event.target.value })}
                      />
                    </label>
                    <label>
                      End
                      <input
                        min="0.1"
                        step="0.1"
                        type="number"
                        value={clip.sourceEnd}
                        disabled={!canEditTimeline || isBusy}
                        onChange={(event) => updateClip(index, { sourceEnd: event.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!canEditTimeline || isBusy || form.clips.length <= 1}
                      onClick={() => removeClip(index)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={form.muted}
                  disabled={!canEditTimeline || isBusy}
                  onChange={(event) => updateForm({ muted: event.target.checked })}
                />
                Mute original audio
              </label>
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={form.zoomEnabled}
                  disabled={!canEditTimeline || isBusy}
                  onChange={(event) => updateForm({ zoomEnabled: event.target.checked })}
                />
                Apply zoom effect
              </label>
              <label>
                Zoom direction
                <select
                  value={form.zoomMode}
                  disabled={!canEditTimeline || isBusy || !form.zoomEnabled}
                  onChange={(event) => updateForm({ zoomMode: event.target.value })}
                >
                  <option value="in">Zoom in</option>
                  <option value="out">Zoom out</option>
                </select>
              </label>
              <label>
                Zoom start
                <input
                  min="0"
                  step="0.1"
                  type="number"
                  value={form.zoomStart}
                  disabled={!canEditTimeline || isBusy || !form.zoomEnabled}
                  onChange={(event) => updateForm({ zoomStart: event.target.value })}
                />
              </label>
              <label>
                Zoom end
                <input
                  min="0.1"
                  step="0.1"
                  type="number"
                  value={form.zoomEnd}
                  disabled={!canEditTimeline || isBusy || !form.zoomEnabled}
                  onChange={(event) => updateForm({ zoomEnd: event.target.value })}
                />
              </label>
              <label>
                Zoom scale
                <input
                  min="1"
                  step="0.01"
                  type="number"
                  value={form.zoomScale}
                  disabled={!canEditTimeline || isBusy || !form.zoomEnabled}
                  onChange={(event) => updateForm({ zoomScale: event.target.value })}
                />
              </label>
              <label>
                Avatar starts at
                <input
                  min="0"
                  step="0.1"
                  type="number"
                  value={form.avatarStart}
                  disabled={!canEditTimeline || isBusy || !avatarTrack}
                  onChange={(event) => updateForm({ avatarStart: event.target.value })}
                />
              </label>
              <label className="studio-callout-text">
                Callout text
                <input
                  value={form.calloutText}
                  disabled={!canEditTimeline || isBusy}
                  onChange={(event) => updateForm({ calloutText: event.target.value })}
                />
              </label>
              <label>
                Callout start
                <input
                  min="0"
                  step="0.1"
                  type="number"
                  value={form.calloutStart}
                  disabled={!canEditTimeline || isBusy}
                  onChange={(event) => updateForm({ calloutStart: event.target.value })}
                />
              </label>
              <label>
                Callout end
                <input
                  min="0.1"
                  step="0.1"
                  type="number"
                  value={form.calloutEnd}
                  disabled={!canEditTimeline || isBusy}
                  onChange={(event) => updateForm({ calloutEnd: event.target.value })}
                />
              </label>
            </div>

            <div className="action-row">
              <button type="button" disabled={!canEditTimeline || isBusy} onClick={saveTimeline}>
                {workflow.isSaving ? "Saving..." : "Save timeline"}
              </button>
              <button className="primary" type="button" disabled={!canEditTimeline || isBusy} onClick={renderProject}>
                {workflow.isRendering ? "Rendering..." : "Render MP4"}
              </button>
            </div>

            {workflow.error && <p className="form-error">{workflow.error}</p>}
            {workflow.message && <p className="form-success">{workflow.message}</p>}
            {projectState.status?.message && <p className="muted">{projectState.status.message}</p>}
            {zoomTrack && <p className="muted">Zoom effect saved from {zoomTrack.timelineStart}s to {zoomTrack.timelineEnd}s.</p>}
            {outputUrl && (
              <a className="studio-output-link" href={outputUrl} target="_blank" rel="noreferrer">
                Open rendered MP4
              </a>
            )}
          </div>
        </section>
      )}

      {deleteConfirmation && (
        <DeleteStudioConfirmationDialog
          confirmation={deleteConfirmation}
          isDeleting={workflow.isDeleting}
          onCancel={() => setDeleteConfirmation(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function FileUploadButton({ accept, disabled, label, onFile }) {
  return (
    <label className="thumbnail-upload-control">
      {label}
      <input
        accept={accept}
        disabled={disabled}
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

function AssetRow({ disabled, label, onDelete, track }) {
  return (
    <div className="studio-asset-row">
      <span>
        <strong>{label}</strong>
        <small>{track.source}</small>
      </span>
      <button className="danger" type="button" disabled={disabled} onClick={() => onDelete(track, label)}>
        Delete
      </button>
    </div>
  );
}

function DeleteStudioConfirmationDialog({ confirmation, isDeleting, onCancel, onConfirm }) {
  return (
    <ModalShell
      className="confirm-dialog"
      closeOnBackdrop={!isDeleting}
      closeOnEscape={!isDeleting}
      labelledBy="delete-studio-title"
      onClose={onCancel}
    >
        <div className="modal-header">
          <div>
            <h2 id="delete-studio-title">{confirmation.title}</h2>
            <span className="muted">{confirmation.detail}</span>
          </div>
          <button aria-label="Close confirmation" className="modal-close" type="button" disabled={isDeleting} onClick={onCancel}>
            x
          </button>
        </div>
        <div className="modal-body">
          <p className="confirm-copy">
            {confirmation.scope === "project"
              ? "This deletes the local Video Studio project, uploaded assets, temporary render files, and output MP4."
              : "This deletes the uploaded file from this Video Studio project and removes it from the timeline."}
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" disabled={isDeleting} onClick={onCancel}>
            Cancel
          </button>
          <button className="danger" type="button" disabled={isDeleting} onClick={onConfirm}>
            {isDeleting ? "Deleting..." : "Delete"}
          </button>
        </div>
    </ModalShell>
  );
}

function timelineFromForm(timeline, form) {
  const tracks = (timeline?.tracks ?? []).map((track) => {
    if (track.type === "video") {
      return {
        ...track,
        muted: Boolean(form.muted),
        clips: timelineClipsFromForm(form.clips)
      };
    }
    if (track.type === "avatar") {
      const avatarStart = Number(form.avatarStart);
      return {
        ...track,
        timelineStart: avatarStart,
        sourceStart: track.sourceStart ?? 0,
        sourceEnd: Math.max(Number(track.sourceEnd ?? 5), Number(track.sourceStart ?? 0) + 0.1)
      };
    }
    return track;
  });

  const withoutDynamicEffects = tracks.filter((track) => !["callout", "zoom"].includes(track.type));
  if (form.zoomEnabled) {
    const zoomScale = Math.max(1, Number(form.zoomScale));
    withoutDynamicEffects.push({
      id: "zoom-1",
      type: "zoom",
      mode: form.zoomMode,
      timelineStart: Number(form.zoomStart),
      timelineEnd: Number(form.zoomEnd),
      startScale: form.zoomMode === "out" ? zoomScale : 1,
      endScale: form.zoomMode === "out" ? 1 : zoomScale
    });
  }

  const withoutCallouts = withoutDynamicEffects;
  if (form.calloutText.trim()) {
    withoutCallouts.push({
      id: "callout-1",
      type: "callout",
      text: form.calloutText.trim(),
      timelineStart: Number(form.calloutStart),
      timelineEnd: Number(form.calloutEnd),
      x: 120,
      y: 820,
      fontSize: 42,
      fontColor: "#F7F5EF",
      boxColor: "#0B2D23",
      borderColor: "#C9A96E"
    });
  }

  return {
    ...timeline,
    title: form.title,
    tracks: withoutCallouts
  };
}

function timelineClipsFromForm(clips) {
  let timelineStart = 0;
  return clips.map((clip) => {
    const sourceStart = Number(clip.sourceStart);
    const sourceEnd = Number(clip.sourceEnd);
    const duration = Math.max(0, sourceEnd - sourceStart);
    const timelineClip = {
      sourceStart,
      sourceEnd,
      timelineStart
    };
    timelineStart += duration;
    return timelineClip;
  });
}

function assetLabel(type) {
  if (type === "screen-video") return "Screen video";
  if (type === "voiceover") return "Voiceover";
  return "Avatar video";
}
