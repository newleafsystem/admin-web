export function LeafLoader({ label = "Loading NewLeaf", compact = false }) {
  return (
    <div className={compact ? "leaf-loader leaf-loader-compact" : "leaf-loader"} role="status" aria-live="polite">
      <span className="leaf-loader-mark" aria-hidden="true">
        <span className="leaf-loader-leaf leaf-loader-leaf-a" />
        <span className="leaf-loader-leaf leaf-loader-leaf-b" />
        <span className="leaf-loader-leaf leaf-loader-leaf-c" />
      </span>
      <span className="leaf-loader-label">{label}</span>
    </div>
  );
}
