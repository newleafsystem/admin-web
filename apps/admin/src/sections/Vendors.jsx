import { useState } from "react";
import { StatusBadge } from "../components/common.jsx";
import { API_BASE_URL } from "../config.js";

const initialVendorDraft = {
  name: "",
  contactEmail: "",
  rateLimitPerMinute: 60,
  isSubmitting: false,
  error: null
};

const apiBaseUrl = API_BASE_URL;
const serviceDocsUrl = `${apiBaseUrl}/service/docs`;

export function Vendors({
  createVendorClient,
  credentialResult,
  revokeVendorClient,
  rotateVendorClient,
  serviceClients
}) {
  const [draft, setDraft] = useState(initialVendorDraft);

  function updateDraft(patch) {
    setDraft((current) => ({
      ...current,
      ...patch,
      error: null
    }));
  }

  async function submitVendor(event) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setDraft((current) => ({ ...current, error: "Enter a vendor name." }));
      return;
    }

    setDraft((current) => ({ ...current, isSubmitting: true, error: null }));
    try {
      await createVendorClient({
        name,
        contactEmail: draft.contactEmail.trim() || null,
        rateLimitPerMinute: Number(draft.rateLimitPerMinute) || 60
      });
      setDraft(initialVendorDraft);
    } catch (error) {
      setDraft((current) => ({ ...current, isSubmitting: false, error: error.message }));
    }
  }

  return (
    <div className="view-stack">
      <section className="panel connect-panel">
        <div className="panel-heading">
          <div>
            <h2>Create Vendor API Access</h2>
            <span className="muted">Signed backend-to-backend access for text-to-HeyGen submissions.</span>
          </div>
          <a className="button-link" href={serviceDocsUrl} target="_blank" rel="noreferrer">
            Open Swagger docs
          </a>
        </div>
        <form className="vendor-form" onSubmit={submitVendor}>
          <label>
            Vendor name
            <input
              value={draft.name}
              onChange={(event) => updateDraft({ name: event.target.value })}
              placeholder="Partner CMS"
            />
          </label>
          <label>
            Contact email
            <input
              type="email"
              value={draft.contactEmail}
              onChange={(event) => updateDraft({ contactEmail: event.target.value })}
              placeholder="ops@example.com"
            />
          </label>
          <label>
            Requests / minute
            <input
              min="1"
              max="600"
              type="number"
              value={draft.rateLimitPerMinute}
              onChange={(event) => updateDraft({ rateLimitPerMinute: event.target.value })}
            />
          </label>
          <button className="primary" type="submit" disabled={draft.isSubmitting}>
            {draft.isSubmitting ? "Creating..." : "Create access"}
          </button>
        </form>
        {draft.error && <p className="form-error">{draft.error}</p>}
      </section>

      {credentialResult && (
        <section className="panel credentials-panel">
          <div className="panel-heading">
            <div>
              <h2>Store These Credentials Now</h2>
              <span className="muted">The signing secret is shown only after create or rotate.</span>
            </div>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Vendor</dt>
              <dd>{credentialResult.client.name}</dd>
            </div>
            <div>
              <dt>Key ID</dt>
              <dd>{credentialResult.credentials.keyId}</dd>
            </div>
            <div>
              <dt>Signing secret</dt>
              <dd>{credentialResult.credentials.signingSecret}</dd>
            </div>
          </dl>
          <label>
            Signature base string
            <textarea
              readOnly
              value={"METHOD\\n/api/v1/service/text-to-heygen/jobs\\nTIMESTAMP\\nSHA256_RAW_BODY_HEX"}
            />
          </label>
          <small>
            Sign the base string with HMAC-SHA256 using the signing secret. Send headers:
            x-newleaf-key-id, x-newleaf-timestamp, and x-newleaf-signature.
          </small>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <h2>Vendor API Clients</h2>
          <span className="muted">{serviceClients.length} client{serviceClients.length === 1 ? "" : "s"}</span>
        </div>
        <div className="table-wrap">
          <table className="vendor-table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Status</th>
                <th>Key ID</th>
                <th>Scopes</th>
                <th>Rate limit</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {serviceClients.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan="7">
                    No vendor clients yet.
                  </td>
                </tr>
              ) : (
                serviceClients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <strong>{client.name}</strong>
                      {client.contactEmail && <small>{client.contactEmail}</small>}
                    </td>
                    <td>
                      <StatusBadge status={client.status} />
                    </td>
                    <td>{client.keyId}</td>
                    <td className="scopes-cell">{client.scopes.join(", ")}</td>
                    <td>{client.rateLimitPerMinute ?? "Default"}/min</td>
                    <td>{client.updatedAt ?? client.createdAt ?? "Unknown"}</td>
                    <td>
                      <div className="table-actions">
                        <button type="button" disabled={client.status !== "active"} onClick={() => rotateVendorClient(client.id)}>
                          Rotate
                        </button>
                        <button className="danger" type="button" disabled={client.status !== "active"} onClick={() => revokeVendorClient(client.id)}>
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
