import { getIntakeMode } from "../utils.js";

export function CreateContent({ contentDraft, intakeModes, submitContentDraft, updateContentDraft }) {
  const selectedMode = getIntakeMode(contentDraft.mode);
  const selectedFile = contentDraft.videoFile;
  const segments = contentDraft.segments ?? [];
  const submitLabel = submitLabelForMode(contentDraft.mode);

  function updateSegment(index, patch) {
    updateContentDraft({
      segments: segments.map((segment, candidateIndex) =>
        candidateIndex === index ? { ...segment, ...patch } : segment
      )
    });
  }

  function addSegment() {
    const lastSequence = Math.max(0, ...segments.map((segment) => Number(segment.sequence) || 0));
    const nextSequence = lastSequence + 10;
    updateContentDraft({
      segments: [
        ...segments,
        {
          sequence: nextSequence,
          segmentKey: `segment_${nextSequence}`,
          title: `Segment ${segments.length + 1}`,
          prompt: "",
          clipFile: null
        }
      ]
    });
  }

  function removeSegment(index) {
    updateContentDraft({
      segments: segments.filter((_, candidateIndex) => candidateIndex !== index)
    });
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <form className="intake-form" onSubmit={submitContentDraft}>
          <div className="panel-heading">
            <div>
              <h2>Prepare Video</h2>
              <span className="muted">{selectedMode.label}</span>
            </div>
            <button className="primary" type="submit" disabled={contentDraft.isSubmitting}>
              {contentDraft.isSubmitting ? submitLabel.busy : submitLabel.ready}
            </button>
          </div>

          <div className="mode-tabs" role="tablist" aria-label="Content intake mode">
            {intakeModes.map((mode) => (
              <button
                className={mode.id === contentDraft.mode ? "mode-tab active" : "mode-tab"}
                key={mode.id}
                type="button"
                onClick={() => updateContentDraft({ mode: mode.id })}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <div className="intake-grid">
            <label>
              Title
              <input
                value={contentDraft.title}
                onChange={(event) => updateContentDraft({ title: event.target.value })}
                placeholder={selectedFile?.name ?? "Video title"}
              />
            </label>
            <label>
              Target duration
              <input
                min="5"
                step="5"
                type="number"
                value={contentDraft.targetDurationSec}
                onChange={(event) => updateContentDraft({ targetDurationSec: event.target.value })}
              />
            </label>
          </div>

          {contentDraft.mode === "video_upload" && (
            <div className="intake-grid single">
              <label>
                Video file
                <input
                  accept="video/*"
                  type="file"
                  onChange={(event) => updateContentDraft({ videoFile: event.target.files?.[0] ?? null })}
                />
              </label>
              {selectedFile && (
                <div className="file-chip">
                  <strong>{selectedFile.name}</strong>
                  <span>{Math.ceil(selectedFile.size / 1024 / 1024)} MB</span>
                </div>
              )}
            </div>
          )}

          {contentDraft.mode === "youtube_embed" && (
            <div className="intake-grid single">
              <label>
                YouTube URL
                <input
                  value={contentDraft.youtubeUrl}
                  onChange={(event) => updateContentDraft({ youtubeUrl: event.target.value })}
                  placeholder="https://www.youtube.com/watch?v=..."
                />
              </label>
            </div>
          )}

          {contentDraft.mode === "text_to_heygen" && (
            <div className="intake-grid text-intake">
              <label>
                Video prompt or script
                <textarea
                  value={contentDraft.prompt}
                  onChange={(event) => updateContentDraft({ prompt: event.target.value })}
                  placeholder="Write the script, topic, audience, offer, and tone."
                />
              </label>
              <div className="thumbnail-column">
                <label>
                  Thumbnail placeholder
                  <input
                    value={contentDraft.thumbnailLabel}
                    onChange={(event) => updateContentDraft({ thumbnailLabel: event.target.value })}
                  />
                </label>
                <div className="thumbnail-placeholder" aria-label="Thumbnail placeholder">
                  <span>Thumbnail</span>
                  <strong>{contentDraft.thumbnailLabel || "Auto placeholder thumbnail"}</strong>
                </div>
              </div>
              <p className="muted form-note">
                Longer HeyGen videos can take a few minutes. The video stays in the queue while rendering continues.
              </p>
            </div>
          )}

          {contentDraft.mode === "segmented_video" && (
            <div className="segment-builder">
              <div className="section-subheading">
                <div>
                  <h3>Timeline segments</h3>
                  <span className="muted">{segments.length} segment{segments.length === 1 ? "" : "s"}</span>
                </div>
                <button type="button" onClick={addSegment}>
                  Add segment
                </button>
              </div>

              <div className="segment-list">
                {segments.map((segment, index) => (
                  <article className="segment-card" key={`${segment.sequence}-${index}`}>
                    <div className="segment-card-top">
                      <label>
                        Sequence
                        <input
                          min="1"
                          step="1"
                          type="number"
                          value={segment.sequence}
                          onChange={(event) => updateSegment(index, { sequence: event.target.value })}
                        />
                      </label>
                      <label>
                        Segment key
                        <input
                          value={segment.segmentKey}
                          onChange={(event) => updateSegment(index, { segmentKey: event.target.value })}
                        />
                      </label>
                      <label>
                        Title
                        <input
                          value={segment.title}
                          onChange={(event) => updateSegment(index, { title: event.target.value })}
                        />
                      </label>
                      <button type="button" disabled={segments.length <= 1} onClick={() => removeSegment(index)}>
                        Remove
                      </button>
                    </div>
                    <div className="segment-card-body">
                      <label>
                        Prompt or script
                        <textarea
                          value={segment.prompt}
                          onChange={(event) => updateSegment(index, { prompt: event.target.value })}
                          placeholder="Segment script, narration, or generation prompt"
                        />
                      </label>
                      <label>
                        Completed clip
                        <input
                          accept="video/*"
                          type="file"
                          onChange={(event) => updateSegment(index, { clipFile: event.target.files?.[0] ?? null })}
                        />
                        {segment.clipFile && (
                          <span className="inline-file-chip">
                            {segment.clipFile.name} - {Math.ceil(segment.clipFile.size / 1024 / 1024)} MB
                          </span>
                        )}
                      </label>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          {contentDraft.error && <p className="form-error">{contentDraft.error}</p>}
          {contentDraft.message && <p className="form-success">{contentDraft.message}</p>}
        </form>
      </section>
    </div>
  );
}

function submitLabelForMode(mode) {
  if (mode === "text_to_heygen" || mode === "segmented_video") {
    return {
      ready: "Generate video",
      busy: "Requesting video..."
    };
  }
  return {
    ready: "Send to review",
    busy: "Sending..."
  };
}
