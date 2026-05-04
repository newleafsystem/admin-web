import { useState } from "react";
import { ProgressMeter, StatusBadge } from "../components/common.jsx";
import { isArchivedPublishPlan } from "../utils.js";

export function AuditLog({ auditEvents = [], publications = [], publishPlans = [] }) {
  const [expandedCards, setExpandedCards] = useState(() => new Set());
  const deletedPublications = sortByAuditTime(
    publications.filter((publication) => publication.status === "deleted"),
    (publication) => publication.metadata?.deletedAt ?? publication.metadata?.lastProgressAt ?? publication.updatedAt
  );
  const archivedPlans = sortByAuditTime(
    publishPlans.filter(isArchivedPublishPlan),
    (plan) => plan.metadata?.archivedToAuditAt ?? plan.updatedAt
  );

  function toggleCard(cardId) {
    setExpandedCards((current) => {
      const next = new Set(current);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }

  function isExpanded(cardId) {
    return expandedCards.has(cardId);
  }

  return (
    <div className="view-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Audit Activity</h2>
            <span className="muted">Session actions with actor, resource, and request details</span>
          </div>
          <span className="muted">{auditEvents.length} event{auditEvents.length === 1 ? "" : "s"}</span>
        </div>
        {auditEvents.length === 0 ? (
          <div className="empty-inline">No audit events in this session.</div>
        ) : (
          <div className="audit-card-list">
            {auditEvents.map((event) => {
              const cardId = `event:${event.id}`;
              return (
                <AuditEventCard
                  event={event}
                  isExpanded={isExpanded(cardId)}
                  key={event.id}
                  onToggle={() => toggleCard(cardId)}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Archived Publishing Records</h2>
            <span className="muted">Provider deletes, archived plans, failed leftovers, and retained audit evidence</span>
          </div>
          <span className="muted">
            {deletedPublications.length} deleted publication{deletedPublications.length === 1 ? "" : "s"}
          </span>
        </div>
        {deletedPublications.length === 0 && archivedPlans.length === 0 ? (
          <div className="empty-inline">No deleted publishing records yet.</div>
        ) : (
          <div className="audit-card-list">
            {archivedPlans.map((plan) => {
              const cardId = `plan:${plan.id}`;
              return (
                <ArchivedPlanCard
                  isExpanded={isExpanded(cardId)}
                  key={cardId}
                  onToggle={() => toggleCard(cardId)}
                  plan={plan}
                />
              );
            })}
            {deletedPublications.map((publication) => {
              const cardId = `publication:${publication.id}`;
              return (
                <DeletedPublicationAuditCard
                  isExpanded={isExpanded(cardId)}
                  key={cardId}
                  onToggle={() => toggleCard(cardId)}
                  publication={publication}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function AuditAccordionCard({
  badge = null,
  children,
  eyebrow,
  isExpanded,
  meta,
  onToggle,
  quickFacts = [],
  subtitle,
  title,
}) {
  function handleSummaryKeyDown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  }

  return (
    <article className={`audit-card${isExpanded ? " is-expanded" : ""}`}>
      <div
        aria-expanded={isExpanded}
        className="audit-card-summary"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={handleSummaryKeyDown}
      >
        <div className="audit-card-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h3>{title}</h3>
            {subtitle && <span className="muted">{subtitle}</span>}
          </div>
          <div className="audit-card-side">
            {badge}
            {meta}
            <span className="audit-expand-indicator" aria-hidden="true">
              {isExpanded ? "-" : "+"}
            </span>
          </div>
        </div>
        <AuditQuickFacts items={quickFacts} />
      </div>

      {isExpanded && <div className="audit-card-details">{children}</div>}
    </article>
  );
}

function AuditQuickFacts({ items }) {
  const visibleItems = items
    .map(([label, value]) => [label, formatDetailValue(value)])
    .filter(([, value]) => value !== null && value !== "");

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <dl className="audit-quick-facts">
      {visibleItems.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AuditEventCard({ event, isExpanded, onToggle }) {
  const details = normalizeDetails(event.details);
  return (
    <AuditAccordionCard
      eyebrow={auditCategory(event.action)}
      isExpanded={isExpanded}
      meta={(
        <div className="audit-meta-stack">
          <span>{event.actor}</span>
          <time>{event.createdAt}</time>
        </div>
      )}
      onToggle={onToggle}
      quickFacts={[
        ["Resource", event.resource],
        ["Actor", event.actor],
        ["Captured", event.createdAt],
        ["Details", details.length ? `${details.length} field${details.length === 1 ? "" : "s"}` : "None"],
      ]}
      subtitle={event.resource}
      title={auditActionLabel(event.action)}
    >
      <KeyValueList
        items={[
          ["Event ID", event.id],
          ["Action", event.action],
          ["Resource", event.resource],
          ["Actor", event.actor],
          ["Captured", event.createdAt]
        ]}
      />

      {details.length > 0 && (
        <>
          <h4 className="audit-subheading">Request Details</h4>
          <KeyValueList items={details} />
        </>
      )}
    </AuditAccordionCard>
  );
}

function ArchivedPlanCard({ isExpanded, onToggle, plan }) {
  const archiveReason = plan.metadata?.archiveReason ?? archiveReasonForPlan(plan);
  const attempts = plan.attempts ?? [];
  const failedAttempts = attempts.filter((attempt) => attempt.status === "failed").length;
  const deletedAttempts = attempts.filter((attempt) => attempt.status === "deleted").length;
  return (
    <AuditAccordionCard
      badge={<StatusBadge status={plan.status} />}
      eyebrow="Archived plan"
      isExpanded={isExpanded}
      onToggle={onToggle}
      quickFacts={[
        ["Plan", plan.id],
        ["Platforms", plan.platforms.join(", ")],
        ["Attempts", attempts.length],
        ["Deleted", deletedAttempts],
        ["Failed", failedAttempts],
        ["Reason", archiveReason],
      ]}
      subtitle={plan.description || "No description captured"}
      title={plan.title}
    >
      <KeyValueList
        items={[
          ["Plan ID", plan.id],
          ["Job ID", plan.jobId],
          ["Platforms", plan.platforms.join(", ")],
          ["Schedule", plan.scheduledAt],
          ["Approved by", plan.approvedBy],
          ["Created", plan.createdAt],
          ["Updated", plan.updatedAt],
          ["Archived at", plan.metadata?.archivedToAuditAt],
          ["Archive reason", archiveReason],
          ["Hashtags", plan.hashtags.map((tag) => `#${tag}`).join(", ")],
          ["YouTube tags", plan.tags.join(", ")]
        ]}
      />

      {attempts.length > 0 && (
        <>
          <h4 className="audit-subheading">Platform Attempts</h4>
          <div className="audit-attempt-grid">
            {attempts.map((attempt) => (
              <AttemptAuditCard attempt={attempt} key={attempt.id ?? attempt.platform} />
            ))}
          </div>
        </>
      )}
    </AuditAccordionCard>
  );
}

function AttemptAuditCard({ attempt }) {
  return (
    <div className="audit-attempt-card">
      <div className="audit-attempt-heading">
        <strong>{attempt.platform}</strong>
        <StatusBadge status={attempt.status} />
      </div>
      <KeyValueList
        items={[
          ["Attempt ID", attempt.id],
          ["Account", attempt.account],
          ["Connected account", attempt.connectedAccountId],
          ["Provider post ID", attempt.providerPostId],
          ["Provider URL", attempt.providerUrl],
          ["Visibility", attempt.privacyStatus],
          ["Error code", attempt.errorCode],
          ["Error message", attempt.errorMessage],
          ["Updated", attempt.updatedAt]
        ]}
      />
      {attempt.publisherStatus && <p className="audit-note">{attempt.publisherStatus}</p>}
      {attempt.progress && <ProgressMeter progress={attempt.progress} />}
    </div>
  );
}

function DeletedPublicationAuditCard({ isExpanded, onToggle, publication }) {
  const metadata = publication.metadata ?? {};
  const providerResponse = summarizeProviderResponse(metadata.providerDeleteResponse);
  return (
    <AuditAccordionCard
      badge={(
        <span className="attempt-actions">
          <StatusBadge status={publication.privacyStatus || "unknown"} />
          <StatusBadge status={publication.status} />
        </span>
      )}
      eyebrow="Deleted publication"
      isExpanded={isExpanded}
      onToggle={onToggle}
      quickFacts={[
        ["Platform", publication.platform],
        ["Account", publication.account],
        ["Post ID", publication.providerPostId],
        ["Deleted by", metadata.deletedBy],
        ["Reason", metadata.deleteReason],
        ["Provider deleted", stringifyValue(metadata.providerDeleted)],
      ]}
      subtitle={`${publication.platform} / ${publication.account}`}
      title={publication.title || publication.providerPostId || publication.id}
    >
      <KeyValueList
        items={[
          ["Publication ID", publication.id],
          ["Plan ID", publication.planId],
          ["Job ID", publication.jobId],
          ["Connected account", publication.connectedAccountId],
          ["Provider post ID", publication.providerPostId],
          ["Provider URL", publication.providerUrl ?? "Removed from provider"],
          ["Published at", publication.publishedAt],
          ["Deleted at", metadata.deletedAt],
          ["Deleted by", metadata.deletedBy],
          ["Delete reason", metadata.deleteReason],
          ["Provider deleted", stringifyValue(metadata.providerDeleted)],
          ["Provider delete response", providerResponse],
          ["External source", publication.externalSource],
          ["Updated", publication.updatedAt]
        ]}
      />

      <h4 className="audit-subheading">Published Metadata</h4>
      <KeyValueList
        items={[
          ["Title", publication.title],
          ["Description", publication.description],
          ["Tags", publication.tags.join(", ")],
          ["Hashtags", publication.hashtags.map((tag) => `#${tag}`).join(", ")],
          ["Last provider status", publication.publisherStatus]
        ]}
      />

      {publication.progress && <ProgressMeter progress={publication.progress} />}
    </AuditAccordionCard>
  );
}

function KeyValueList({ items }) {
  const visibleItems = items
    .map(([label, value]) => [label, formatDetailValue(value)])
    .filter(([, value]) => value !== null && value !== "");

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <dl className="detail-list compact-details audit-detail-list">
      {visibleItems.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{isUrl(value) ? <a href={value} target="_blank" rel="noreferrer">{value}</a> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

function normalizeDetails(details = {}) {
  return Object.entries(details).map(([key, value]) => [detailLabel(key), value]);
}

function detailLabel(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDetailValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(formatNestedValue).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return stringifyValue(value);
}

function formatNestedValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return stringifyValue(value);
}

function stringifyValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value);
}

function summarizeProviderResponse(response) {
  if (!response) {
    return null;
  }
  if (typeof response !== "object") {
    return response;
  }
  const summary = [
    response.status ? `status ${response.status}` : null,
    response.deleted === true || response.success === true ? "confirmed" : null,
    response.alreadyMissing ? "already missing at provider" : null
  ].filter(Boolean);
  return summary.length > 0 ? summary.join(", ") : JSON.stringify(response);
}

function archiveReasonForPlan(plan) {
  const attempts = plan.attempts ?? [];
  if (attempts.length > 0 && attempts.every((attempt) => attempt.status === "deleted")) {
    return "All platform publications were deleted.";
  }
  if (attempts.some((attempt) => attempt.status === "deleted")) {
    return "Deleted publications retained with failed platform leftovers.";
  }
  return "Archived publishing record.";
}

function auditActionLabel(action) {
  return detailLabel(action);
}

function auditCategory(action) {
  if (action.includes("publish") || action.includes("publication") || action.includes("sync")) {
    return "Publishing";
  }
  if (action.includes("account")) {
    return "Account";
  }
  if (action.includes("review") || action.includes("summary") || action.includes("regenerate")) {
    return "Review";
  }
  return "Content";
}

function sortByAuditTime(records, getTime) {
  return [...records].sort((left, right) => parseAuditTime(getTime(right)) - parseAuditTime(getTime(left)));
}

function parseAuditTime(value) {
  const timestamp = Date.parse(value ?? 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ""));
}
