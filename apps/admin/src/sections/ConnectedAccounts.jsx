import { StatusBadge } from "../components/common.jsx";
import { getPlatformConfig } from "../utils.js";

export function ConnectedAccounts({
  accountWorkflow,
  accounts,
  closeConnectAccount,
  completeAccountConnection,
  disconnectAccount,
  openConnectAccount,
  reconnectAccount,
  socialPlatforms,
  updateAccountWorkflow
}) {
  const accountCountByPlatform = new Map(
    socialPlatforms.map((platform) => [
      platform.id,
      accounts.filter(
        (account) => account.platform.toLowerCase() === platform.id || account.platform.toLowerCase() === platform.label.toLowerCase()
      ).length
    ])
  );
  const selectedPlatform = getPlatformConfig(accountWorkflow.platform);

  return (
    <div className="view-stack">
      <section className="platform-grid" aria-label="Publishing platforms">
        {socialPlatforms.map((platform) => {
          const count = accountCountByPlatform.get(platform.id) ?? 0;
          return (
            <article className="platform-card" key={platform.id}>
              <div>
                <strong>{platform.label}</strong>
                <small>{platform.provider}</small>
              </div>
              <StatusBadge status={count > 0 ? "configured" : "disconnected"} />
              <dl className="platform-meta">
                <div>
                  <dt>Accounts</dt>
                  <dd>{count}</dd>
                </div>
                <div>
                  <dt>Scopes</dt>
                  <dd>{platform.scopes.join(", ")}</dd>
                </div>
                <div>
                  <dt>Publisher</dt>
                  <dd>{platform.publisherEnabled ? "Enabled" : "OAuth only"}</dd>
                </div>
              </dl>
              <button type="button" onClick={() => openConnectAccount(platform.id)}>
                Connect
              </button>
            </article>
          );
        })}
      </section>

      {accountWorkflow.isOpen && (
        <section className="panel connect-panel" aria-label="Connect account">
          <div className="panel-heading">
            <h2>Connect Account</h2>
            <button type="button" onClick={closeConnectAccount}>
              Cancel
            </button>
          </div>
          <form className="connect-form" onSubmit={completeAccountConnection}>
            <label>
              Platform
              <select
                value={accountWorkflow.platform}
                onChange={(event) => updateAccountWorkflow({ platform: event.target.value })}
              >
                {socialPlatforms.map((platform) => (
                  <option key={platform.id} value={platform.id}>
                    {platform.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Account label
              <input
                value={accountWorkflow.accountName}
                onChange={(event) => updateAccountWorkflow({ accountName: event.target.value })}
                placeholder={selectedPlatform.defaultAccountName}
              />
            </label>
            <div className="scope-preview">
              <span>{selectedPlatform.provider}</span>
              <strong>{selectedPlatform.scopes.join(", ")}</strong>
            </div>
            <button className="primary" type="submit" disabled={accountWorkflow.isSubmitting}>
              {accountWorkflow.isSubmitting ? "Opening OAuth..." : `Authorize ${selectedPlatform.label}`}
            </button>
          </form>
          {accountWorkflow.error && <p className="form-error">{accountWorkflow.error}</p>}
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <h2>Connected Accounts</h2>
          <button type="button" onClick={() => openConnectAccount()}>
            Connect account
          </button>
        </div>
        <div className="table-wrap accounts-table-wrap">
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Account</th>
                <th>Status</th>
                <th>Scopes</th>
                <th>Token health</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan="6">
                    No connected accounts yet. Use Connect account to authorize a channel.
                  </td>
                </tr>
              ) : (
                accounts.map((account) => (
                  <tr key={account.id}>
                    <td>{account.platform}</td>
                    <td>
                      <strong>{account.accountName}</strong>
                      <small>{account.updatedAt}</small>
                    </td>
                    <td>
                      <StatusBadge status={account.status} />
                    </td>
                    <td className="scopes-cell">{account.scopes.join(", ")}</td>
                    <td className="token-health-cell">
                      {account.tokenHealth}
                      {account.tokenSource && <small>{account.tokenSource}</small>}
                    </td>
                    <td>
                      <div className="table-actions">
                        <button type="button" onClick={() => reconnectAccount(account.id)}>
                          Reconnect
                        </button>
                        <button type="button" onClick={() => disconnectAccount(account.id)}>
                          Remove
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
