import { useMemo, useState } from "react";
import { notificationTopicOptions } from "../api.js";
import { ModalShell, StatusBadge } from "../components/common.jsx";

const styles = {
  metricsGrid: {
    display: "grid",
    gap: 12,
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    marginBottom: 18
  },
  metric: {
    background: "#f8fafc",
    border: "1px solid #d9e2ea",
    borderRadius: 8,
    display: "grid",
    gap: 4,
    padding: 14
  },
  metricValue: {
    color: "#102034",
    fontSize: 24,
    fontWeight: 900
  },
  table: {
    minWidth: 1040,
    tableLayout: "fixed"
  },
  userColumn: {
    width: "24%"
  },
  emailColumn: {
    width: "25%"
  },
  topicsColumn: {
    width: "34%"
  },
  statusColumn: {
    width: "10%"
  },
  actionColumn: {
    width: "7%"
  },
  userCell: {
    display: "grid",
    gap: 4
  },
  mutedSmall: {
    color: "#5b6678",
    fontSize: 12,
    lineHeight: 1.35
  },
  tagList: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: 8
  },
  tag: {
    alignItems: "center",
    background: "#eef3f8",
    border: "1px solid rgba(18, 86, 68, 0.12)",
    borderRadius: 999,
    color: "#31425a",
    display: "inline-flex",
    fontSize: 12,
    fontWeight: 800,
    gap: 6,
    minHeight: 28,
    padding: "7px 10px"
  },
  activeTag: {
    background: "#dff1e9",
    color: "#0f5f48"
  },
  pausedTag: {
    background: "#fff7ed",
    color: "#9a5b10"
  },
  empty: {
    color: "#5b6678",
    fontSize: 12
  },
  formGrid: {
    display: "grid",
    gap: 14
  },
  field: {
    display: "grid",
    gap: 7
  },
  input: {
    border: "1px solid #d6dee8",
    borderRadius: 8,
    font: "inherit",
    minHeight: 42,
    padding: "9px 11px"
  },
  topicGrid: {
    display: "grid",
    gap: 10,
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))"
  },
  topicChoice: {
    alignItems: "flex-start",
    background: "#ffffff",
    border: "1px solid #d6dee8",
    borderRadius: 8,
    color: "#152033",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minHeight: 92,
    padding: 14,
    textAlign: "left",
    width: "100%"
  },
  topicChoiceSelected: {
    background: "#edf7f3",
    borderColor: "#6ab49e",
    boxShadow: "0 0 0 2px rgba(106, 180, 158, 0.18)"
  },
  choiceLabel: {
    alignItems: "center",
    display: "flex",
    fontWeight: 900,
    gap: 8
  },
  choiceMark: {
    background: "#125644",
    borderRadius: 999,
    color: "#ffffff",
    fontSize: 10,
    padding: "3px 7px",
    textTransform: "uppercase"
  },
  switchRow: {
    alignItems: "center",
    display: "flex",
    gap: 10,
    justifyContent: "space-between"
  },
  switchButton: {
    borderRadius: 999,
    minWidth: 96
  }
};

export function Notifications({ onRefresh, onUpdateUserNotifications, users }) {
  const [editTarget, setEditTarget] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const sortedUsers = useMemo(
    () =>
      [...users].sort((left, right) => {
        const leftRecipient = isEmailRecipient(left);
        const rightRecipient = isEmailRecipient(right);
        if (leftRecipient !== rightRecipient) return leftRecipient ? -1 : 1;
        return String(left.displayName ?? left.email).localeCompare(String(right.displayName ?? right.email));
      }),
    [users]
  );

  const metrics = useMemo(() => buildMetrics(users), [users]);

  function openEditor(user) {
    setEditTarget(user);
    setDraft(copyEmailPreferences(user));
  }

  function closeEditor() {
    if (saving) return;
    setEditTarget(null);
    setDraft(null);
  }

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function toggleTopic(topicId) {
    setDraft((current) => ({
      ...current,
      topics: {
        ...current.topics,
        [topicId]: !current.topics[topicId]
      }
    }));
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!editTarget || !draft || !canSaveDraft(draft)) return;
    setSaving(true);
    try {
      await onUpdateUserNotifications(editTarget.id, {
        email: {
          ...draft,
          address: String(draft.address ?? "").trim() || null
        }
      });
      setEditTarget(null);
      setDraft(null);
    } catch {
      // App.jsx owns the visible action error.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Email Notifications</h2>
            <span className="muted">Manage recipient status and notification topics from user records.</span>
          </div>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        </div>

        <div style={styles.metricsGrid}>
          <Metric label="Active recipients" value={metrics.activeRecipients} />
          <Metric label="Weekly picks" value={metrics.weeklyPicks} />
          <Metric label="Operational alerts" value={metrics.operationalAlerts} />
          <Metric label="Paused email" value={metrics.paused} />
        </div>

        <div className="table-wrap">
          <table className="accounts-table" style={styles.table}>
            <thead>
              <tr>
                <th style={styles.userColumn}>User</th>
                <th style={styles.emailColumn}>Recipient email</th>
                <th style={styles.topicsColumn}>Topics</th>
                <th style={styles.statusColumn}>Status</th>
                <th style={styles.actionColumn}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedUsers.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan="5">
                    No users have signed in yet.
                  </td>
                </tr>
              ) : (
                sortedUsers.map((user) => {
                  const email = getEmailPreferences(user);
                  return (
                    <tr key={user.id}>
                      <td style={styles.userColumn}>
                        <div style={styles.userCell}>
                          <strong>{user.displayName}</strong>
                          <small>{user.email}</small>
                        </div>
                      </td>
                      <td style={styles.emailColumn}>
                        <div style={styles.userCell}>
                          <span>{email.address || "No email address"}</span>
                          <span style={styles.mutedSmall}>
                            {email.enabled ? "Email delivery enabled" : "Email delivery paused"}
                          </span>
                        </div>
                      </td>
                      <td style={styles.topicsColumn}>
                        <TopicTags email={email} />
                      </td>
                      <td style={styles.statusColumn}>
                        <StatusBadge status={email.enabled ? "active" : "paused"} />
                      </td>
                      <td style={styles.actionColumn}>
                        <button type="button" onClick={() => openEditor(user)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editTarget && draft && (
        <NotificationDialog
          draft={draft}
          saving={saving}
          user={editTarget}
          onCancel={closeEditor}
          onSave={saveEditor}
          onToggleTopic={toggleTopic}
          onUpdateDraft={updateDraft}
        />
      )}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={styles.metric}>
      <span className="muted">{label}</span>
      <strong style={styles.metricValue}>{value}</strong>
    </div>
  );
}

function TopicTags({ email }) {
  if (!email.enabled) {
    return <span style={{ ...styles.tag, ...styles.pausedTag }}>Paused</span>;
  }

  const enabledTopics = notificationTopicOptions.filter((topic) => email.topics?.[topic.id]);
  if (enabledTopics.length === 0) {
    return <span style={styles.empty}>No topics enabled</span>;
  }

  return (
    <div style={styles.tagList}>
      {enabledTopics.map((topic) => (
        <span key={topic.id} style={{ ...styles.tag, ...styles.activeTag }}>
          {topic.label}
        </span>
      ))}
    </div>
  );
}

function NotificationDialog({ draft, onCancel, onSave, onToggleTopic, onUpdateDraft, saving, user }) {
  const valid = canSaveDraft(draft);

  return (
    <ModalShell className="confirm-dialog" labelledBy="manage-notifications-title" onClose={onCancel}>
      <form onSubmit={onSave}>
        <div className="modal-header">
          <div>
            <h2 id="manage-notifications-title">Manage Email Notifications</h2>
            <span className="muted">{user.displayName} - {user.email}</span>
          </div>
          <button aria-label="Close notifications dialog" className="modal-close" disabled={saving} type="button" onClick={onCancel}>
            x
          </button>
        </div>

        <div className="modal-body" style={styles.formGrid}>
          <div style={styles.switchRow}>
            <div>
              <strong>Email delivery</strong>
              <p style={styles.mutedSmall}>Controls whether this user receives any configured email topic.</p>
            </div>
            <button
              aria-pressed={draft.enabled}
              className={draft.enabled ? "primary" : ""}
              style={styles.switchButton}
              type="button"
              onClick={() => onUpdateDraft({ enabled: !draft.enabled })}
            >
              {draft.enabled ? "Enabled" : "Paused"}
            </button>
          </div>

          <label style={styles.field}>
            <span>Recipient email</span>
            <input
              disabled={saving}
              style={styles.input}
              type="email"
              value={draft.address}
              onChange={(event) => onUpdateDraft({ address: event.target.value })}
            />
          </label>

          <div style={styles.field}>
            <span>Topics</span>
            <div style={styles.topicGrid}>
              {notificationTopicOptions.map((topic) => (
                <button
                  aria-pressed={Boolean(draft.topics?.[topic.id])}
                  disabled={saving}
                  key={topic.id}
                  style={{
                    ...styles.topicChoice,
                    ...(draft.topics?.[topic.id] ? styles.topicChoiceSelected : {})
                  }}
                  type="button"
                  onClick={() => onToggleTopic(topic.id)}
                >
                  <span style={styles.choiceLabel}>
                    {topic.label}
                    {draft.topics?.[topic.id] && <span style={styles.choiceMark}>On</span>}
                  </span>
                  <span style={styles.mutedSmall}>{topic.description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button disabled={saving} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={saving || !valid} type="submit">
            {saving ? "Saving..." : "Save notifications"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function buildMetrics(users) {
  return users.reduce(
    (totals, user) => {
      const email = getEmailPreferences(user);
      if (email.enabled) totals.activeRecipients += 1;
      if (!email.enabled && email.address) totals.paused += 1;
      if (email.enabled && email.topics.weeklyPicks) totals.weeklyPicks += 1;
      if (
        email.enabled &&
        (email.topics.scannerAlerts || email.topics.publishingAlerts || email.topics.systemAlerts)
      ) {
        totals.operationalAlerts += 1;
      }
      return totals;
    },
    { activeRecipients: 0, weeklyPicks: 0, operationalAlerts: 0, paused: 0 }
  );
}

function isEmailRecipient(user) {
  const email = getEmailPreferences(user);
  return Boolean(email.enabled && email.address && Object.values(email.topics ?? {}).some(Boolean));
}

function copyEmailPreferences(user) {
  const email = getEmailPreferences(user);
  return {
    enabled: email.enabled,
    address: email.address,
    topics: { ...email.topics }
  };
}

function getEmailPreferences(user) {
  const email = user.notificationPreferences?.email ?? {};
  return {
    enabled: Boolean(email.address) && email.enabled !== false,
    address: email.address ?? user.email ?? "",
    topics: {
      weeklyPicks: email.topics?.weeklyPicks !== false,
      scannerAlerts: email.topics?.scannerAlerts === true,
      publishingAlerts: email.topics?.publishingAlerts === true,
      accountAccess: email.topics?.accountAccess !== false,
      systemAlerts: email.topics?.systemAlerts === true
    }
  };
}

function canSaveDraft(draft) {
  if (!draft) return false;
  if (draft.enabled && !String(draft.address ?? "").trim()) return false;
  return Object.values(draft.topics ?? {}).some(Boolean);
}
