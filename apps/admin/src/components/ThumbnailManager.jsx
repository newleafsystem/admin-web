import { useEffect, useState } from "react";
import { ThumbnailImage } from "./ThumbnailImage.jsx";

export function ThumbnailManager({ job, uploadThumbnail, generateThumbnail, showPreview = true }) {
  const [workflow, setWorkflow] = useState({
    isUploading: false,
    isGenerating: false,
    error: null,
    message: null
  });
  const [atSeconds, setAtSeconds] = useState(2);

  useEffect(() => {
    setWorkflow({ isUploading: false, isGenerating: false, error: null, message: null });
    setAtSeconds(2);
  }, [job?.id]);

  if (!job) {
    return null;
  }

  const isBusy = workflow.isUploading || workflow.isGenerating;
  const hasVideo = job.video.playbackKind === "direct" && job.video.playbackUrl;

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setWorkflow({ isUploading: true, isGenerating: false, error: null, message: null });
    try {
      await uploadThumbnail(job.id, file);
      setWorkflow({
        isUploading: false,
        isGenerating: false,
        error: null,
        message: "Thumbnail uploaded."
      });
    } catch (error) {
      setWorkflow({
        isUploading: false,
        isGenerating: false,
        error: error.message,
        message: null
      });
    }
  }

  async function handleGenerate() {
    setWorkflow({ isUploading: false, isGenerating: true, error: null, message: null });
    try {
      await generateThumbnail(job.id, atSeconds);
      setWorkflow({
        isUploading: false,
        isGenerating: false,
        error: null,
        message: "Thumbnail generated."
      });
    } catch (error) {
      setWorkflow({
        isUploading: false,
        isGenerating: false,
        error: error.message,
        message: null
      });
    }
  }

  return (
    <section className="thumbnail-manager">
      {showPreview && (
        <div className="thumbnail-preview">
          <ThumbnailImage alt={`${job.title} thumbnail`} src={job.thumbnail?.url}>
            <div className="thumbnail-empty">
              <span>Thumbnail</span>
              <strong>{job.title}</strong>
            </div>
          </ThumbnailImage>
        </div>
      )}

      <div className="thumbnail-controls">
        <label className="thumbnail-upload-control">
          {workflow.isUploading ? "Uploading..." : "Upload thumbnail"}
          <input
            accept="image/jpeg,image/png,image/webp"
            disabled={isBusy}
            type="file"
            onChange={handleUpload}
          />
        </label>
        <span className="inline-control thumbnail-generate-control">
          <input
            aria-label="Thumbnail timestamp in seconds"
            disabled={isBusy}
            min="0"
            max="3600"
            step="0.5"
            type="number"
            value={atSeconds}
            onChange={(event) => setAtSeconds(event.target.value)}
          />
          <button type="button" disabled={isBusy || !hasVideo} onClick={handleGenerate}>
            {workflow.isGenerating ? "Generating..." : "Generate"}
          </button>
        </span>
      </div>

      {!hasVideo && (
        <small>Generation needs a local or assembled video artifact. Upload still works for any video source.</small>
      )}
      {job.thumbnail?.updatedAt && <small>Current thumbnail: {job.thumbnail.source ?? "selected"} - {job.thumbnail.updatedAt}</small>}
      {workflow.error && <p className="form-error">{workflow.error}</p>}
      {workflow.message && <p className="form-success">{workflow.message}</p>}
    </section>
  );
}
