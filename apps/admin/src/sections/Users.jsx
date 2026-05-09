import { useMemo, useState } from "react";
import { ModalShell, StatusBadge } from "../components/common.jsx";

const PRODUCT_ACCESS_OPTIONS = [
  {
    id: "invest",
    label: "Invest",
    description: "Investment and trading workspace access."
  },
  {
    id: "picks",
    label: "Picks",
    description: "Curated picks and model-supported ideas."
  },
  {
    id: "workbench",
    label: "Workbench",
    description: "Research workspace and supporting tools."
  },
  {
    id: "quant",
    label: "Quant",
    description: "Quantitative analysis and model workflows."
  },
  {
    id: "desk",
    label: "Desk",
    description: "Operations desk access."
  }
];

const tagBase = {
  alignItems: "center",
  border: "1px solid rgba(18, 86, 68, 0.16)",
  borderRadius: 999,
  display: "inline-flex",
  fontSize: 12,
  fontWeight: 700,
  gap: 8,
  lineHeight: 1,
  minHeight: 28,
  padding: "7px 10px"
};

const styles = {
  addButton: {
    alignSelf: "flex-start",
    minHeight: 30,
    padding: "6px 10px"
  },
  accessColumn: {
    verticalAlign: "middle",
    width: "34%"
  },
  accessHelp: {
    color: "#5b6678",
    display: "block",
    fontSize: 12,
    lineHeight: 1.35,
    marginTop: 2,
    maxWidth: 420
  },
  accessStack: {
    alignItems: "flex-start",
    display: "flex",
    flexDirection: "column",
    gap: 8
  },
  choiceGrid: {
    display: "grid",
    gap: 10,
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))"
  },
  choice: {
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
  choiceDisabled: {
    cursor: "not-allowed",
    opacity: 0.58
  },
  choiceSelected: {
    background: "#edf7f3",
    borderColor: "#6ab49e",
    boxShadow: "0 0 0 2px rgba(106, 180, 158, 0.18)"
  },
  choiceDescription: {
    color: "#5b6678",
    fontSize: 12,
    lineHeight: 1.35
  },
  choiceLabel: {
    alignItems: "center",
    display: "flex",
    fontWeight: 800,
    gap: 8
  },
  choiceMark: {
    background: "#125644",
    borderRadius: 999,
    color: "#ffffff",
    fontSize: 10,
    letterSpacing: 0,
    padding: "3px 7px",
    textTransform: "uppercase"
  },
  emptyAccess: {
    color: "#5b6678",
    fontSize: 12
  },
  loginCell: {
    display: "grid",
    gap: 4,
    minWidth: 170
  },
  loginColumn: {
    verticalAlign: "middle",
    width: "20%"
  },
  loginMeta: {
    color: "#4f5e75",
    fontSize: 12,
    lineHeight: 1.35
  },
  removeTag: {
    alignItems: "center",
    background: "rgba(255, 255, 255, 0.74)",
    border: "0",
    borderRadius: 999,
    color: "inherit",
    display: "inline-flex",
    fontSize: 12,
    fontWeight: 900,
    height: 18,
    justifyContent: "center",
    minHeight: 18,
    padding: 0,
    width: 18
  },
  rolePill: {
    ...tagBase,
    background: "#eef3f8",
    color: "#334155"
  },
  rolePillAdmin: {
    ...tagBase,
    background: "#dff1e9",
    color: "#0f5f48"
  },
  roleColumn: {
    verticalAlign: "middle",
    width: "8%"
  },
  sectionLabel: {
    color: "#40516b",
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0,
    marginTop: 10,
    textTransform: "uppercase"
  },
  tag: {
    ...tagBase,
    background: "#f3f6f9",
    color: "#31425a"
  },
  tagAdmin: {
    ...tagBase,
    background: "#dff1e9",
    color: "#0f5f48"
  },
  tagList: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: 8
  },
  usersTable: {
    minWidth: 1180,
    tableLayout: "fixed"
  },
  statusColumn: {
    verticalAlign: "middle",
    width: "11%"
  },
  userColumn: {
    verticalAlign: "middle",
    width: "19%"
  },
  actionColumn: {
    verticalAlign: "middle",
    width: "8%"
  }
};

export function Users({ currentUserId, onDeleteUser, onRefresh, onUpdateRole, users }) {
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [accessTarget, setAccessTarget] = useState(null);
  const [accessSelection, setAccessSelection] = useState(null);
  const [savingAccess, setSavingAccess] = useState(false);
  const sortedUsers = useMemo(
    () =>
      [...users].sort((left, right) => {
        if (left.immutable !== right.immutable) return left.immutable ? -1 : 1;
        if (left.role !== right.role) return left.role === "admin" ? -1 : 1;
        return String(right.lastLoginAt ?? "").localeCompare(String(left.lastLoginAt ?? ""));
      }),
    [users]
  );

  async function confirmDelete() {
    if (!deleteTarget) return;
    await onDeleteUser(deleteTarget.id);
    setDeleteTarget(null);
  }

  function openAccessDialog(user) {
    setAccessTarget(user);
    setAccessSelection(selectionFromUser(user));
  }

  function toggleAccessSelection(accessId) {
    setAccessSelection((current) => {
      const next = { ...(current ?? emptyAccessSelection()) };
      if (accessId === "admin") {
        return {
          ...emptyAccessSelection(),
          admin: !next.admin
        };
      }
      next.admin = false;
      next[accessId] = !next[accessId];
      return next;
    });
  }

  async function saveAccessDialog() {
    if (!accessTarget || !accessSelection) return;
    setSavingAccess(true);
    try {
      const nextRole = accessSelection.admin ? "admin" : "anonymous";
      const nextAppAccess = accessSelection.admin ? undefined : appAccessFromSelection(accessSelection);
      await onUpdateRole(accessTarget.id, nextRole, nextAppAccess);
      setAccessTarget(null);
      setAccessSelection(null);
    } catch {
      // App.jsx owns user-facing action errors.
    } finally {
      setSavingAccess(false);
    }
  }

  async function removeAdminAccess(user) {
    await onUpdateRole(user.id, "anonymous", emptyAppAccess());
  }

  async function removeProductAccess(user, appId) {
    await onUpdateRole(user.id, "anonymous", {
      ...completeAppAccess(user.appAccess),
      [appId]: false,
      admin: false
    });
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>User Access</h2>
            <span className="muted">{users.length} signed-in user{users.length === 1 ? "" : "s"}</span>
          </div>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        </div>

        <div className="table-wrap users-table-wrap">
          <table className="accounts-table users-table" style={styles.usersTable}>
            <thead>
              <tr>
                <th style={styles.userColumn}>User</th>
                <th style={styles.roleColumn}>Role</th>
                <th style={styles.accessColumn}>Access</th>
                <th style={styles.statusColumn}>Status</th>
                <th style={styles.loginColumn}>Last login</th>
                <th style={styles.actionColumn}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedUsers.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan="6">
                    No users have signed in yet.
                  </td>
                </tr>
              ) : (
                sortedUsers.map((user) => {
                  const locked = user.immutable;
                  return (
                    <tr key={user.id}>
                      <td style={styles.userColumn}>
                        <div className="user-cell">
                          <strong>{user.displayName}</strong>
                          <small>{user.email}</small>
                          {user.id === currentUserId && <small>Current session</small>}
                        </div>
                      </td>
                      <td style={styles.roleColumn}>
                        <RolePill user={user} />
                      </td>
                      <td style={styles.accessColumn}>
                        <AccessTags
                          locked={locked}
                          user={user}
                          onAdd={() => openAccessDialog(user)}
                          onRemoveAdmin={() => removeAdminAccess(user)}
                          onRemoveProduct={(appId) => removeProductAccess(user, appId)}
                        />
                      </td>
                      <td style={styles.statusColumn}>
                        <div className="status-stack">
                          <StatusBadge status={user.status} />
                          {locked && <span className="locked-note">Protected owner</span>}
                        </div>
                      </td>
                      <td style={styles.loginColumn}>
                        <LastLoginCell user={user} />
                      </td>
                      <td style={styles.actionColumn}>
                        <button type="button" disabled={locked} onClick={() => setDeleteTarget(user)}>
                          Remove
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

      {accessTarget && accessSelection && (
        <AccessDialog
          saving={savingAccess}
          selection={accessSelection}
          user={accessTarget}
          onCancel={() => {
            if (!savingAccess) {
              setAccessTarget(null);
              setAccessSelection(null);
            }
          }}
          onSave={saveAccessDialog}
          onToggle={toggleAccessSelection}
        />
      )}

      {deleteTarget && (
        <DeleteUserDialog
          user={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function RolePill({ user }) {
  const admin = isAdminUser(user);
  return <span style={admin ? styles.rolePillAdmin : styles.rolePill}>{admin ? "Admin" : "Member"}</span>;
}

function AccessTags({ locked, onAdd, onRemoveAdmin, onRemoveProduct, user }) {
  if (isAdminUser(user)) {
    return (
      <div style={styles.accessStack}>
        <div style={styles.tagList}>
          <span style={styles.tagAdmin}>
            Admin for NewLeaf System
            {!locked && (
              <button
                aria-label={`Remove admin access from ${user.email}`}
                style={styles.removeTag}
                type="button"
                onClick={onRemoveAdmin}
              >
                x
              </button>
            )}
          </span>
        </div>
        <span style={styles.accessHelp}>Admin role grants full admin-web and client-web access.</span>
      </div>
    );
  }

  const enabledApps = PRODUCT_ACCESS_OPTIONS.filter((option) => Boolean(user.appAccess?.[option.id]));

  return (
    <div style={styles.accessStack}>
      {enabledApps.length > 0 ? (
        <div style={styles.tagList}>
          {enabledApps.map((option) => (
            <span key={option.id} style={styles.tag}>
              {option.label}
              {!locked && (
                <button
                  aria-label={`Remove ${option.label} access from ${user.email}`}
                  style={styles.removeTag}
                  type="button"
                  onClick={() => onRemoveProduct(option.id)}
                >
                  x
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <span style={styles.emptyAccess}>No product access</span>
      )}
      {!locked && (
        <button style={styles.addButton} type="button" onClick={onAdd}>
          Add access
        </button>
      )}
    </div>
  );
}

function LastLoginCell({ user }) {
  const context = user.lastLoginContext;
  const location = formatLoginLocation(context);
  const coordinates = formatCoordinates(context);

  return (
    <div style={styles.loginCell}>
      <span>{user.lastLoginAt ?? user.updatedAt ?? "Not recorded"}</span>
      {context?.ipAddress && <span style={styles.loginMeta}>{context.ipAddress}</span>}
      <span style={styles.loginMeta}>{location ?? "Location not available"}</span>
      {coordinates && <span style={styles.loginMeta}>{coordinates}</span>}
    </div>
  );
}

function AccessDialog({ onCancel, onSave, onToggle, saving, selection, user }) {
  const adminSelected = Boolean(selection.admin);

  return (
    <ModalShell className="confirm-dialog" labelledBy="manage-user-access-title" onClose={onCancel}>
      <div className="modal-header">
        <div>
          <h2 id="manage-user-access-title">Manage Access</h2>
          <span className="muted">{user.email}</span>
        </div>
        <button aria-label="Close access dialog" className="modal-close" disabled={saving} type="button" onClick={onCancel}>
          x
        </button>
      </div>

      <div className="modal-body">
        <div style={styles.choiceGrid}>
          <AccessChoice
            description="Full administrative access across admin-web and client-web."
            label="Admin"
            selected={adminSelected}
            onToggle={() => onToggle("admin")}
          />
        </div>

        <div style={styles.sectionLabel}>Product access</div>
        <div style={styles.choiceGrid}>
          {PRODUCT_ACCESS_OPTIONS.map((option) => (
            <AccessChoice
              description={option.description}
              disabled={adminSelected}
              key={option.id}
              label={option.label}
              selected={!adminSelected && Boolean(selection[option.id])}
              onToggle={() => onToggle(option.id)}
            />
          ))}
        </div>
        {adminSelected && (
          <span style={styles.accessHelp}>Product selections are hidden because admin role already includes them.</span>
        )}
      </div>

      <div className="modal-actions">
        <button disabled={saving} type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={saving} type="button" onClick={onSave}>
          {saving ? "Saving..." : "Save access"}
        </button>
      </div>
    </ModalShell>
  );
}

function AccessChoice({ description, disabled = false, label, onToggle, selected }) {
  return (
    <button
      aria-pressed={selected}
      disabled={disabled}
      style={{
        ...styles.choice,
        ...(selected ? styles.choiceSelected : {}),
        ...(disabled ? styles.choiceDisabled : {})
      }}
      type="button"
      onClick={onToggle}
    >
      <span style={styles.choiceLabel}>
        {label}
        {selected && <span style={styles.choiceMark}>Selected</span>}
      </span>
      <span style={styles.choiceDescription}>{description}</span>
    </button>
  );
}

function DeleteUserDialog({ user, onCancel, onConfirm }) {
  return (
    <ModalShell className="confirm-dialog" labelledBy="delete-user-title" onClose={onCancel}>
      <div className="modal-header">
        <div>
          <h2 id="delete-user-title">Remove User Access</h2>
          <span className="muted">{user.email}</span>
        </div>
        <button aria-label="Close confirmation" className="modal-close" type="button" onClick={onCancel}>
          x
        </button>
      </div>

      <div className="modal-body">
        <p className="confirm-copy">
          This removes the app role record. If this person signs in again, they will return as anonymous.
        </p>
      </div>

      <div className="modal-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="danger" type="button" onClick={onConfirm}>
          Remove access
        </button>
      </div>
    </ModalShell>
  );
}

function isAdminUser(user) {
  return user.role === "admin" || user.roles?.includes("admin");
}

function selectionFromUser(user) {
  if (isAdminUser(user)) {
    return {
      ...emptyAccessSelection(),
      admin: true
    };
  }
  return {
    ...emptyAccessSelection(),
    ...Object.fromEntries(PRODUCT_ACCESS_OPTIONS.map((option) => [option.id, Boolean(user.appAccess?.[option.id])]))
  };
}

function emptyAccessSelection() {
  return {
    admin: false,
    ...Object.fromEntries(PRODUCT_ACCESS_OPTIONS.map((option) => [option.id, false]))
  };
}

function appAccessFromSelection(selection) {
  return {
    ...emptyAppAccess(),
    ...Object.fromEntries(PRODUCT_ACCESS_OPTIONS.map((option) => [option.id, Boolean(selection[option.id])]))
  };
}

function completeAppAccess(appAccess = {}) {
  return {
    ...emptyAppAccess(),
    ...Object.fromEntries(PRODUCT_ACCESS_OPTIONS.map((option) => [option.id, Boolean(appAccess?.[option.id])]))
  };
}

function emptyAppAccess() {
  return {
    admin: false,
    ...Object.fromEntries(PRODUCT_ACCESS_OPTIONS.map((option) => [option.id, false]))
  };
}

function formatLoginLocation(context) {
  if (!context) return null;
  const location = [context.city, context.region, context.country].filter(Boolean).join(", ");
  return location || context.timezone || context.source || null;
}

function formatCoordinates(context) {
  if (!context?.latitude || !context?.longitude) return null;
  return `${context.latitude}, ${context.longitude}`;
}
