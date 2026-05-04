import { statusText } from "../constants.js";
import { API_BASE_URL } from "../config.js";

export function StatusBadge({ status }) {
  const label = statusText[status] ?? status.replaceAll("_", " ");
  return <span className={`status status-${status}`}>{label}</span>;
}

export function VideoPlayer({ job }) {
  if (job.video.playbackKind === "youtube" && job.video.playbackUrl) {
    return (
      <div className="video-frame playable">
        <iframe
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          src={job.video.playbackUrl}
          title={job.title}
        />
      </div>
    );
  }

  if (job.video.playbackKind === "direct" && job.video.playbackUrl) {
    return (
      <div className="video-frame playable">
        <video controls src={job.video.playbackUrl} />
      </div>
    );
  }

  return (
    <div className="video-frame">
      <div>
        <strong>{job.video.status}</strong>
        <span>{job.video.externalId ?? "Video preview pending"}</span>
      </div>
    </div>
  );
}

export function SummaryBlock({ label, value }) {
  return (
    <div className="summary-block">
      <span>{label}</span>
      <p>{value || "Not provided"}</p>
    </div>
  );
}

export function ProgressMeter({ progress }) {
  const percent = Math.min(100, Math.max(0, Number(progress.percent) || 0));
  return (
    <div className="progress-meter">
      <div className="progress-meter-label">
        <span>{progress.label}</span>
        <strong>{percent}%</strong>
      </div>
      <div
        aria-label="Operation progress"
        aria-valuemax="100"
        aria-valuemin="0"
        aria-valuenow={percent}
        className="progress-track"
        role="progressbar"
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-meter-foot">
        <span>{progress.stage?.replaceAll("_", " ") ?? "not started"}</span>
        <span>{uploadBytesLabel(progress)}</span>
        <span>{progress.lastProgressAt ?? "No progress event yet"}</span>
      </div>
    </div>
  );
}

function uploadBytesLabel(progress) {
  if (!progress.totalBytes) {
    return "Size pending";
  }
  const uploaded = progress.uploadedBytes ?? 0;
  return `${formatBytes(uploaded)} / ${formatBytes(progress.totalBytes)}`;
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** index;
  return `${amount >= 10 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

export { API_BASE_URL };
