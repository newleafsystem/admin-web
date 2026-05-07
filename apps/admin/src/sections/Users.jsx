import { useState } from "react";
import { ModalShell, StatusBadge } from "../components/common.jsx";

const ROLE_OPTIONS = ["admin", "anonymous"];

export function Users({ currentUserId, onDeleteUser, onRefresh, onUpdateRole, users }) {
  const [deleteTarget, setDeleteTarget] = useState(null);
  const sortedUsers = [...users].sort((left, right) => {
    if (left.immutable !== right.immutable) return left.immutable ? -1 : 1;
    if (left.role !== right.role) return left.role === "admin" ? -1 : 1;
    return String(right.lastLoginAt ?? "").localeCompare(String(left.lastLoginAt ?? ""));
  });

  async function confirmDelete() {
    if (!deleteTarget) return;
    await onDeleteUser(deleteTarget.id);
    setDeleteTarget(null);
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
          <table className="accounts-table users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th>Action</th>
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
                  const locked = user.immutable;
                  return (
                    <tr key={user.id}>
                      <td>
                        <div className="user-cell">
                          <strong>{user.displayName}</strong>
                          <small>{user.email}</small>
                          {user.id === currentUserId && <small>Current session</small>}
                        </div>
                      </td>
                      <td>
                        {locked ? (
                          <StatusBadge status="admin" />
                        ) : (
                          <select
                            aria-label={`Role for ${user.email}`}
                            value={user.role}
                            onChange={(event) => onUpdateRole(user.id, event.target.value)}
                          >
                            {ROLE_OPTIONS.map((role) => (
                              <option key={role} value={role}>
                                {role === "admin" ? "Admin" : "Anonymous"}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <div className="status-stack">
                          <StatusBadge status={user.status} />
                          {locked && <span className="locked-note">Protected owner</span>}
                        </div>
                      </td>
                      <td>{user.lastLoginAt ?? user.updatedAt ?? "Not recorded"}</td>
                      <td>
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
