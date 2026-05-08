export const brandLogoUrl = "/logo-icon-192.png";

export function BrandLogo({ className = "", alt = "" }) {
  const classes = ["brand-logo", className].filter(Boolean).join(" ");

  return <img className={classes} src={brandLogoUrl} alt={alt} width="64" height="64" decoding="async" />;
}
