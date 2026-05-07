import { useEffect, useRef } from "react";
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

export function ModalShell({
  children,
  className = "",
  closeOnBackdrop = true,
  closeOnEscape = true,
  labelledBy,
  onClose
}) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    window.setTimeout(() => dialogRef.current?.focus(), 0);

    return () => {
      const previousFocus = previousFocusRef.current;
      if (previousFocus && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (!closeOnEscape) {
      return undefined;
    }

    function closeWithEscape(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
      }
    }

    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [closeOnEscape, onClose]);

  function closeFromBackdrop(event) {
    if (closeOnBackdrop && event.target === event.currentTarget) {
      onClose?.();
    }
  }

  function trapFocus(event) {
    if (event.key !== "Tab") {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const focusable = dialog.querySelectorAll(
      [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "[tabindex]:not([tabindex='-1'])"
      ].join(", ")
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={`modal-dialog ${className}`.trim()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        {children}
      </section>
    </div>
  );
}

export function useCloseOnOutside(active, onClose) {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    function closeFromOutside(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        onClose?.();
      }
    }

    function closeWithEscape(event) {
      if (event.key === "Escape") {
        onClose?.();
      }
    }

    document.addEventListener("pointerdown", closeFromOutside, true);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [active, onClose]);

  return rootRef;
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
