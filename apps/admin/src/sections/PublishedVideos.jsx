import { useState } from "react";
import { ProgressMeter, StatusBadge } from "../components/common.jsx";
import { ThumbnailManager } from "../components/ThumbnailManager.jsx";
import { ThumbnailImage } from "../components/ThumbnailImage.jsx";
import { platformIdFromLabel, platformLabel } from "../utils.js";

export function PublishedVideos({
  importPlatformChannelPublications,
  jobs,
  publicationDrafts,
  publicationImportWorkflow,
  publications,
  requestJobPublicationsDelete,
  requestPublicationDelete,
  requestPublicationHype,
  savePublication,
  generateThumbnail,
  socialPlatforms,
  updatePublicationDraft,
  uploadThumbnail
}) {
  const [visibilityFilter, setVisibilityFilter] = useState("all");
  const [recordFilter, setRecordFilter] = useState("active");
  const [deleteConfirmation, setDeleteConfirmation] = useState(null);
  const [metadataEditorId, setMetadataEditorId] = useState(null);
  const [openActionMenuId, setOpenActionMenuId] = useState(null);
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const jobTitleById = new Map(jobs.map((job) => [job.id, job.title]));
  const visibleRecordCount = publications.filter((publication) => matchesRecordFilter(publication, recordFilter)).length;
  const channelCountByJobId = new Map();

  for (const publication of publications) {
    if (publication.status !== "deleted") {
      channelCountByJobId.set(publication.jobId, (channelCountByJobId.get(publication.jobId) ?? 0) + 1);
    }
  }

  const sections = buildPublicationSections(publications, socialPlatforms, visibilityFilter, recordFilter);

  function openDeleteConfirmation(config) {
    setOpenActionMenuId(null);
    setDeleteConfirmation(config);
  }

  function closeDeleteConfirmation() {
    setDeleteConfirmation(null);
  }

  function openMetadataEditor(publicationId) {
    setOpenActionMenuId(null);
    setMetadataEditorId(publicationId);
  }

  function closeMetadataEditor() {
    setMetadataEditorId(null);
  }

  function confirmDelete() {
    if (!deleteConfirmation) {
      return;
    }
    if (deleteConfirmation.scope === "all") {
      requestJobPublicationsDelete(deleteConfirmation.jobId);
    } else {
      requestPublicationDelete(deleteConfirmation.publicationId);
    }
    closeDeleteConfirmation();
  }

  function updateMetadataField(publicationId, patch) {
    updatePublicationDraft(publicationId, patch);
  }

  async function savePublicationMetadata(publicationId, draft) {
    const payload = {
      title: draft.title,
      description: draft.description,
      tags: parseDelimitedList(draft.tagsText),
      hashtags: parseDelimitedList(draft.hashtagsText).map((hashtag) => hashtag.replace(/^#+/, ""))
    };
    if (draft.privacyStatus && draft.privacyStatus !== "unknown") {
      payload.privacyStatus = draft.privacyStatus;
    }
    await savePublication(publicationId, payload);
  }

  async function uploadPublicationThumbnail(publication, file) {
    const updatedJob = await uploadThumbnail(publication.jobId, file);
    await savePublication(publication.id, {
      metadata: publicationThumbnailMetadata(updatedJob)
    });
    return updatedJob;
  }

  async function generatePublicationThumbnail(publication, atSeconds) {
    const updatedJob = await generateThumbnail(publication.jobId, atSeconds);
    await savePublication(publication.id, {
      metadata: publicationThumbnailMetadata(updatedJob)
    });
    return updatedJob;
  }

  return (
    <div className="view-stack">
      <section className="panel publication-toolbar">
        <div className="panel-heading">
          <div>
            <h2>Published Library</h2>
            <span className="muted">
              {visibleRecordCount} shown of {publications.length} platform record{publications.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="publication-toolbar-actions">
            <div className="publication-filters">
              <label>
                Records
                <select value={recordFilter} onChange={(event) => setRecordFilter(event.target.value)}>
                  <option value="active">Active records</option>
                  <option value="deleted">Deleted records</option>
                  <option value="all">All records</option>
                </select>
              </label>
              <label>
                Visibility
                <select value={visibilityFilter} onChange={(event) => setVisibilityFilter(event.target.value)}>
                  <option value="all">All visibility</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="unknown">Unknown</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </section>

      {publicationImportWorkflow?.error && <section className="form-error">{publicationImportWorkflow.error}</section>}

      {sections.map((section) => {
        const syncAction = platformSyncAction(section, {
          importPlatformChannelPublications,
          publicationImportWorkflow
        });

        return (
          <section className={`panel platform-publication-section platform-brand-${section.id}`} key={section.id}>
            <div className="panel-heading platform-section-heading">
              <div>
                <h2>{section.label}</h2>
                <span className="muted">{section.publications.length} video{section.publications.length === 1 ? "" : "s"}</span>
              </div>
              {syncAction && (
                <button
                  aria-label={syncAction.ariaLabel}
                  className={`brand-sync-button${syncAction.isSyncing ? " is-syncing" : ""}`}
                  disabled={syncAction.disabled}
                  title={syncAction.title}
                  type="button"
                  onClick={syncAction.onClick}
                >
                  <SyncIcon />
                  <span>{syncAction.label}</span>
                </button>
              )}
            </div>

            {section.publications.length === 0 ? (
              <div className="empty-inline">No videos in this filter.</div>
            ) : (
              <div className="publication-grid video-card-grid">
                {section.publications.map((publication) => {
                  const isDeleted = publication.status === "deleted";
                  const draft = publicationDrafts[publication.id] ?? {
                    title: publication.title,
                    description: publication.description,
                    privacyStatus: publication.privacyStatus,
                    tagsText: publication.tags.join(", "),
                    hashtagsText: publication.hashtags?.join(", ") ?? "",
                    isSaving: false,
                    error: null
                  };
                  const title = draft.title || jobTitleById.get(publication.jobId) || publication.id;

                  if (isDeleted) {
                    return (
                      <DeletedPublicationCard
                        draft={draft}
                        key={publication.id}
                        publication={publication}
                        title={title}
                      />
                    );
                  }

                  return (
                    <ActivePublicationCard
                      channelCount={channelCountByJobId.get(publication.jobId) ?? 0}
                      draft={draft}
                      isMenuOpen={openActionMenuId === publication.id}
                      jobTitle={jobTitleById.get(publication.jobId)}
                      key={publication.id}
                      onCloseMenu={() => setOpenActionMenuId(null)}
                      onDelete={openDeleteConfirmation}
                      onHype={(publicationId) => {
                        setOpenActionMenuId(null);
                        requestPublicationHype(publicationId);
                      }}
                      onOpenMetadata={openMetadataEditor}
                      onToggleMenu={() =>
                        setOpenActionMenuId((current) => (current === publication.id ? null : publication.id))
                      }
                      publication={publication}
                      title={title}
                    />
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      {deleteConfirmation && (
        <DeleteConfirmationDialog
          confirmation={deleteConfirmation}
          onCancel={closeDeleteConfirmation}
          onConfirm={confirmDelete}
        />
      )}

      {metadataEditorId && (
        <MetadataEditorDialog
          draft={publicationDrafts[metadataEditorId]}
          job={publicationJob(publications.find((publication) => publication.id === metadataEditorId), jobById)}
          onCancel={closeMetadataEditor}
          onGenerateThumbnail={generatePublicationThumbnail}
          onSave={savePublicationMetadata}
          onUpdateMetadataField={updateMetadataField}
          onUploadThumbnail={uploadPublicationThumbnail}
          publication={publications.find((publication) => publication.id === metadataEditorId)}
        />
      )}
    </div>
  );
}

function platformSyncAction(section, { importPlatformChannelPublications, publicationImportWorkflow }) {
  const isImporting = publicationImportWorkflow?.isImporting && publicationImportWorkflow?.platform === section.id;
  if (["youtube", "x", "linkedin", "instagram", "facebook"].includes(section.id)) {
    return {
      ariaLabel: `Sync ${section.label} videos`,
      disabled: isImporting,
      isSyncing: isImporting,
      label: isImporting ? `Syncing ${section.label}...` : `Sync ${section.label}`,
      onClick: () => importPlatformChannelPublications(section.id),
      title: `Import videos from the connected ${section.label} account.`
    };
  }

  return {
    ariaLabel: `Sync ${section.label} videos`,
    disabled: true,
    isSyncing: false,
    label: `Sync ${section.label}`,
    onClick: undefined,
    title: `${section.label} channel sync is not wired yet.`
  };
}

function publicationJob(publication, jobById) {
  if (!publication) {
    return null;
  }
  const job = jobById.get(publication.jobId);
  if (!job) {
    return null;
  }
  if (job.thumbnail?.url || !publication.thumbnailUrl) {
    return job;
  }
  return {
    ...job,
    thumbnail: {
      url: publication.thumbnailUrl,
      source: publication.metadata?.thumbnailSource ?? publication.externalSource ?? "publication",
      updatedAt: publication.updatedAt
    }
  };
}

function publicationThumbnailMetadata(job) {
  return {
    thumbnailArtifactId: job?.thumbnail?.artifactId ?? null,
    thumbnailUrl: job?.thumbnail?.url ?? null,
    thumbnailSource: job?.thumbnail?.source ?? null,
    thumbnailUpdatedAt: new Date().toISOString()
  };
}

function parseDelimitedList(value) {
  return Array.from(
    new Set(
      String(value ?? "")
        .split(/[,\n]/)
        .map((item) => item.trim().replace(/^#+/, "").replace(/\s+/g, " "))
        .filter(Boolean)
    )
  );
}

function SyncIcon() {
  return (
    <svg aria-hidden="true" className="sync-button-icon" focusable="false" viewBox="0 0 24 24">
      <path d="M20 6v5h-5" />
      <path d="M4 18v-5h5" />
      <path d="M18.2 9A7 7 0 0 0 6.4 6.7L4 9" />
      <path d="M5.8 15A7 7 0 0 0 17.6 17.3L20 15" />
    </svg>
  );
}

function ActivePublicationCard({
  channelCount,
  draft,
  isMenuOpen,
  jobTitle,
  onCloseMenu,
  onDelete,
  onHype,
  onOpenMetadata,
  onToggleMenu,
  publication,
  title
}) {
  const hasProviderUrl = Boolean(publication.providerUrl);
  const isSaving = Boolean(draft.isSaving);
  const metaLine = [
    publication.account,
    publication.publishedAt ? `Published ${publication.publishedAt}` : `Updated ${publication.updatedAt ?? "Unknown"}`
  ]
    .filter(Boolean)
    .join(" - ");

  return (
    <article className="video-library-card">
      <div className="video-card-menu">
        <button
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          aria-label={`Open actions for ${title}`}
          className="icon-button"
          type="button"
          onClick={onToggleMenu}
        >
          ...
        </button>
        {isMenuOpen && (
          <div className="card-menu" role="menu">
            {hasProviderUrl ? (
              <a href={publication.providerUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={onCloseMenu}>
                Open video
              </a>
            ) : (
              <button type="button" role="menuitem" disabled>
                Open video
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => onHype(publication.id)}>
              Hype video
            </button>
            <button type="button" role="menuitem" onClick={() => onOpenMetadata(publication.id)}>
              Edit metadata
            </button>
            {channelCount > 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  onDelete({
                    scope: "all",
                    jobId: publication.jobId,
                    title: jobTitle || title,
                    platform: "all channels"
                  })
                }
              >
                Delete from all channels
              </button>
            )}
            <button
              className="danger-menu-item"
              type="button"
              role="menuitem"
              onClick={() =>
                onDelete({
                  scope: "single",
                  publicationId: publication.id,
                  title,
                  platform: platformLabel(publication.platform)
                })
              }
            >
              Delete from channel
            </button>
          </div>
        )}
      </div>

      <div className="video-thumbnail">
        <ThumbnailImage src={publication.thumbnailUrl} alt="">
          <div className="video-thumbnail-placeholder">
            <span>{platformLabel(publication.platform)}</span>
            <strong>{title}</strong>
          </div>
        </ThumbnailImage>
      </div>

      <div className="video-card-body">
        <div className="video-card-heading">
          <h3>{title}</h3>
          <div className="video-card-badges">
            <StatusBadge status={publication.privacyStatus || "unknown"} />
            <StatusBadge status={publication.status} />
          </div>
        </div>
        <p className="video-card-meta">{metaLine}</p>
        <div className="video-card-stats">
          <span>{publication.viewCount ? `${publication.viewCount} views` : publication.providerPostId ?? "Pending ID"}</span>
          {publication.likeCount && <span>{publication.likeCount} likes</span>}
          {publication.externalSource && <span>Imported</span>}
        </div>

        <div className="video-card-actions">
          {hasProviderUrl ? (
            <a className="button-link" href={publication.providerUrl} target="_blank" rel="noreferrer">
              Open
            </a>
          ) : (
            <button type="button" disabled>
              Open
            </button>
          )}
          <button type="button" disabled={isSaving} onClick={() => onOpenMetadata(publication.id)}>
            {isSaving ? "Saving..." : "Edit"}
          </button>
        </div>

        {publication.status !== "published" && <ProgressMeter progress={publication.progress} />}
        {draft.error && <p className="form-error">{draft.error}</p>}
      </div>
    </article>
  );
}

function DeletedPublicationCard({ draft, publication, title }) {
  return (
    <article className="publication-card deleted-record">
      <div className="panel-heading">
        <div>
          <h3>{title}</h3>
          <span className="muted">{publication.account}</span>
        </div>
        <span className="attempt-actions">
          <StatusBadge status={publication.privacyStatus || "unknown"} />
          <StatusBadge status={publication.status} />
        </span>
      </div>

      <div className="deleted-record-note">
        Deleted from the provider. The record is retained for audit and troubleshooting.
      </div>

      <dl className="detail-list compact-details">
        <div>
          <dt>Post ID</dt>
          <dd>{publication.providerPostId ?? "Pending"}</dd>
        </div>
        <div>
          <dt>URL</dt>
          <dd>{publication.providerUrl ?? "Removed from provider"}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{publication.updatedAt ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd>{publication.publisherStatus ?? "Deleted from platform."}</dd>
        </div>
      </dl>

      <ProgressMeter progress={publication.progress} />
      {draft.error && <p className="form-error">{draft.error}</p>}
    </article>
  );
}

function MetadataEditorDialog({
  draft,
  job,
  onCancel,
  onGenerateThumbnail,
  onSave,
  onUpdateMetadataField,
  onUploadThumbnail,
  publication
}) {
  if (!publication) {
    return null;
  }

  const editorDraft = draft ?? {
    title: publication.title,
    description: publication.description,
    privacyStatus: publication.privacyStatus,
    tagsText: publication.tags.join(", "),
    hashtagsText: publication.hashtags?.join(", ") ?? "",
    isSaving: false,
    error: null
  };
  const isSaving = Boolean(editorDraft.isSaving);
  const canSaveMetadata = Boolean(String(editorDraft.title ?? "").trim() && String(editorDraft.description ?? "").trim());

  async function save() {
    await onSave(publication.id, editorDraft);
    onCancel();
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        aria-labelledby="metadata-editor-title"
        aria-modal="true"
        className="modal-dialog publication-metadata-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="metadata-editor-title">Edit Publication</h2>
            <span className="muted">{platformLabel(publication.platform)} - {publication.account}</span>
          </div>
          <button aria-label="Close metadata editor" className="modal-close" type="button" onClick={onCancel}>
            x
          </button>
        </div>

        <div className="publication-fields metadata-dialog-fields">
          <label>
            Title
            <input
              value={editorDraft.title ?? ""}
              disabled={isSaving}
              onChange={(event) => onUpdateMetadataField(publication.id, { title: event.target.value })}
            />
          </label>
          <label>
            Visibility
            <select
              value={editorDraft.privacyStatus || publication.privacyStatus || "unknown"}
              disabled={isSaving}
              onChange={(event) => onUpdateMetadataField(publication.id, { privacyStatus: event.target.value })}
            >
              <option value="unknown" disabled>
                Unknown
              </option>
              <option value="private">Private</option>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
            </select>
          </label>
          <label>
            Tags
            <input
              value={editorDraft.tagsText ?? ""}
              disabled={isSaving}
              placeholder="tag1, tag2"
              onChange={(event) => onUpdateMetadataField(publication.id, { tagsText: event.target.value })}
            />
          </label>
          <label>
            Hashtags
            <input
              value={editorDraft.hashtagsText ?? ""}
              disabled={isSaving}
              placeholder="#newleaf, #trading"
              onChange={(event) => onUpdateMetadataField(publication.id, { hashtagsText: event.target.value })}
            />
          </label>
          <label className="publication-description">
            Description
            <textarea
              value={editorDraft.description ?? ""}
              disabled={isSaving}
              onChange={(event) => onUpdateMetadataField(publication.id, { description: event.target.value })}
            />
          </label>
        </div>

        <div className="published-thumbnail-controls metadata-thumbnail-controls">
          <ThumbnailManager
            generateThumbnail={(jobId, atSeconds) => onGenerateThumbnail(publication, atSeconds)}
            job={job}
            showPreview
            uploadThumbnail={(jobId, file) => onUploadThumbnail(publication, file)}
          />
        </div>

        {editorDraft.error && <p className="form-error">{editorDraft.error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={isSaving || !canSaveMetadata} onClick={() => save().catch(() => {})}>
            {isSaving ? "Saving..." : "Save metadata"}
          </button>
        </div>
      </section>
    </div>
  );
}

function DeleteConfirmationDialog({ confirmation, onCancel, onConfirm }) {
  const isBulkDelete = confirmation.scope === "all";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        aria-labelledby="delete-publication-title"
        aria-modal="true"
        className="modal-dialog confirm-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="delete-publication-title">
              {isBulkDelete ? "Delete From All Channels" : "Delete From Channel"}
            </h2>
            <span className="muted">{confirmation.title}</span>
          </div>
          <button aria-label="Close confirmation" className="modal-close" type="button" onClick={onCancel}>
            x
          </button>
        </div>

        <p className="confirm-copy">
          {isBulkDelete
            ? "This will remove the published video from every channel where provider deletion is available."
            : `This will remove the published video from ${confirmation.platform}.`}
        </p>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger" type="button" onClick={onConfirm}>
            {isBulkDelete ? "Delete from all channels" : "Delete from channel"}
          </button>
        </div>
      </section>
    </div>
  );
}

function buildPublicationSections(publications, platforms, visibilityFilter, recordFilter) {
  const filtered = publications.filter(
    (publication) =>
      matchesRecordFilter(publication, recordFilter) &&
      (visibilityFilter === "all" || (publication.privacyStatus || "unknown") === visibilityFilter)
  );
  const labels = new Map(platforms.map((platform) => [platform.id, platform.label]));
  const sections = platforms.map((platform) => ({
    id: platform.id,
    label: platformLabel(platform.label),
    publications: []
  }));
  const sectionById = new Map(sections.map((section) => [section.id, section]));

  for (const publication of sortPublications(filtered)) {
    const id = platformIdFromLabel(publication.platform);
    if (!sectionById.has(id)) {
      const section = {
        id,
        label: platformLabel(labels.get(id) ?? publication.platform),
        publications: []
      };
      sectionById.set(id, section);
      sections.push(section);
    }
    sectionById.get(id).publications.push(publication);
  }

  return sections;
}

function sortPublications(publications) {
  return [...publications].sort((left, right) => publicationTime(right) - publicationTime(left));
}

function publicationTime(publication) {
  return Date.parse(publication.metadata?.publishedAt ?? publication.metadata?.syncedAt ?? publication.updatedAt ?? 0) || 0;
}

function matchesRecordFilter(publication, recordFilter) {
  if (recordFilter === "deleted") {
    return publication.status === "deleted";
  }
  if (recordFilter === "active") {
    return publication.status !== "deleted";
  }
  return true;
}
