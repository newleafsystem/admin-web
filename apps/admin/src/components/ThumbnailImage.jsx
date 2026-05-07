import { useEffect, useMemo, useState } from "react";
import { DEFAULT_THUMBNAIL_URL } from "../config.js";

const LOCAL_DEFAULT_THUMBNAIL_URL = "/default-thumbnail.svg";

export function ThumbnailImage({ alt = "", children = null, className = "", loading = "lazy", src = null }) {
  const sources = useMemo(
    () =>
      [src, DEFAULT_THUMBNAIL_URL, LOCAL_DEFAULT_THUMBNAIL_URL]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index),
    [src]
  );
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sources.join("|")]);

  const currentSource = sources[sourceIndex];
  if (!currentSource) {
    return children;
  }

  return (
    <img
      alt={alt}
      className={className || undefined}
      loading={loading}
      src={currentSource}
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
}
