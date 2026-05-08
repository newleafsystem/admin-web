export const canonicalLegalLinks = Object.freeze({
  privacyPolicy: "https://newleafsystem.com/privacy-policy",
  termsAndConditions: "https://newleafsystem.com/terms-and-conditions"
});

export function PublicFooter({ className = "" }) {
  const year = new Date().getFullYear();
  const classes = ["auth-footer", className].filter(Boolean).join(" ");

  return (
    <footer className={classes}>
      <span>Copyright {year} NewLeaf System. All rights reserved.</span>
      <nav aria-label="Legal links">
        <a href={canonicalLegalLinks.privacyPolicy}>Privacy Policy</a>
        <a href={canonicalLegalLinks.termsAndConditions}>Terms and Conditions</a>
      </nav>
    </footer>
  );
}
