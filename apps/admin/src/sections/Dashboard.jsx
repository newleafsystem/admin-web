import { StatusBadge } from "../components/common.jsx";
import { isArchivedPublishPlan, isReviewableJob } from "../utils.js";

const FLOW_STATUSES = [
  { key: "review_required", label: "Needs Review", tone: "amber" },
  { key: "approved", label: "Approved", tone: "green" },
  { key: "publishing", label: "Publishing", tone: "blue" },
  { key: "published", label: "Published", tone: "green" },
  { key: "partial_failed", label: "Needs Retry", tone: "red" },
  { key: "failed", label: "Failed", tone: "red" }
];

const SOURCE_COLORS = ["#27745c", "#2364aa", "#9a6700", "#6f7a85", "#b42318"];
const PLATFORM_COLORS = {
  youtube: "#ff0033",
  linkedin: "#0a66c2",
  x: "#111111",
  instagram: "#c13584",
  facebook: "#1877f2",
  tiktok: "#111111",
  unknown: "#667085"
};

export function Dashboard({
  connectedAccounts = [],
  jobs,
  metrics,
  publications = [],
  publishPlans,
  setActiveView,
  setSelectedJobId,
  users = []
}) {
  const activePlans = publishPlans.filter((plan) => !isArchivedPublishPlan(plan));
  const highRiskJobs = jobs.filter((job) => job.risk === "high" && isReviewableJob(job));
  const reviewJobs = jobs.filter(isReviewableJob);
  const priorityJobs = Array.from(new Map([...highRiskJobs, ...reviewJobs].map((job) => [job.id, job])).values()).slice(0, 5);
  const duePlans = activePlans.filter((plan) => !["published", "deleted"].includes(plan.status)).slice(0, 5);
  const activePublications = publications.filter((publication) => publication.status !== "deleted");
  const failedPublicationRecords = publications.filter((publication) => publication.status === "failed").length;
  const activeAttempts = activePlans.flatMap((plan) => plan.attempts ?? []);
  const failedAttempts = activeAttempts.filter((attempt) => attempt.status === "failed").length;
  const totalViews = sumPublicationMetric(activePublications, "view");
  const totalLikes = sumPublicationMetric(activePublications, "like");
  const contentFlow = buildContentFlow(jobs);
  const sourceMix = buildSourceMix(jobs);
  const platformReports = buildPlatformReports(activePublications);
  const topVideos = buildTopPublishedVideos(activePublications).slice(0, 5);
  const activitySeries = buildActivitySeries(activePublications);
  const publishHealth = buildPublishHealth(activePlans, activeAttempts, activePublications);
  const accountStats = buildAccountStats(connectedAccounts);
  const userReport = buildUserReport(users);
  const recentActivity = buildRecentActivity({ jobs, activePlans, publications }).slice(0, 7);
  const summaryMetrics = [
    ...metrics,
    {
      label: "Published records",
      value: activePublications.length,
      tone: "green",
      helper: `${formatNumber(totalViews)} views`
    },
    {
      label: "Channel accounts",
      value: accountStats.connected,
      tone: accountStats.attention > 0 ? "amber" : "green",
      helper: accountStats.attention > 0 ? `${accountStats.attention} need attention` : "Connected"
    },
    {
      label: "Signed-in users",
      value: userReport.total,
      tone: userReport.anonymous > 0 ? "amber" : "green",
      helper: `${userReport.admins} admin / ${userReport.anonymous} anonymous`
    }
  ];

  return (
    <div className="dashboard-stack">
      <section className="dashboard-report-grid">
        <article className="panel dashboard-command-panel">
          <div className="dashboard-command-copy">
            <span className="eyebrow">Operations Report</span>
            <h2>Publishing pipeline overview</h2>
            <p>
              {reviewJobs.length} videos need review, {activePlans.length} publish plans are active, and{" "}
              {failedAttempts + failedPublicationRecords} publishing records need attention.
            </p>
          </div>
          <div className="dashboard-command-actions">
            <button type="button" className="primary" onClick={() => setActiveView("Create Content")}>
              Add video
            </button>
            <button type="button" onClick={() => setActiveView(reviewJobs.length > 0 ? "Review" : "Content Queue")}>
              {reviewJobs.length > 0 ? "Open review" : "Open queue"}
            </button>
          </div>
        </article>

        <article className="panel dashboard-health-panel">
          <div className="panel-heading">
            <div>
              <h2>Publishing Health</h2>
              <span className="muted">{publishHealth.total} active or recent channel operations</span>
            </div>
            <StatusBadge status={publishHealth.failed > 0 ? "attention" : publishHealth.active > 0 ? "processing" : "healthy"} />
          </div>
          <div className="dashboard-health-meter">
            {publishHealth.segments.map((segment) => (
              <span
                key={segment.label}
                aria-label={`${segment.label}: ${segment.value}`}
                className={`dashboard-health-segment dashboard-health-${segment.tone} dashboard-hover-target`}
                style={{ width: `${segment.percent}%` }}
                tabIndex={0}
                title={`${segment.label}: ${segment.value}`}
              >
                <em className="dashboard-chart-tooltip">
                  {segment.label}: {segment.value} ({segment.percent}%)
                </em>
              </span>
            ))}
          </div>
          <div className="dashboard-health-legend">
            {publishHealth.segments.map((segment) => (
              <span key={segment.label}>
                <i className={`dashboard-dot dashboard-dot-${segment.tone}`} />
                {segment.label}: {segment.value}
              </span>
            ))}
          </div>
        </article>
      </section>

      <section className="dashboard-kpi-grid" aria-label="Operational metrics">
        {summaryMetrics.map((metric) => (
          <article className={`metric metric-${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            {metric.helper && <small>{metric.helper}</small>}
          </article>
        ))}
      </section>

      <section className="dashboard-main-grid">
        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>Content Lifecycle</h2>
              <span className="muted">{jobs.length} total videos tracked</span>
            </div>
          </div>
          <div className="dashboard-funnel">
            {contentFlow.map((item) => (
              <div className="dashboard-funnel-row dashboard-hover-target" key={item.key} tabIndex={0}>
                <span>{item.label}</span>
                <div className="dashboard-bar-track" aria-label={`${item.label}: ${item.value}`}>
                  <i className={`dashboard-bar dashboard-bar-${item.tone}`} style={{ width: `${item.percent}%` }} />
                </div>
                <strong>{item.value}</strong>
                <em className="dashboard-chart-tooltip">
                  {item.label}: {item.value} video{item.value === 1 ? "" : "s"} ({item.percent}% of queue)
                </em>
              </div>
            ))}
          </div>
        </article>

        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>Source Mix</h2>
              <span className="muted">How videos are entering the pipeline</span>
            </div>
          </div>
          <div className="dashboard-source-report">
            <div
              className="dashboard-donut dashboard-hover-target"
              style={{ background: sourceMix.background }}
              aria-label="Source mix chart"
              tabIndex={0}
            >
              <span>{jobs.length}</span>
              <em className="dashboard-chart-tooltip">Total videos by source: {jobs.length}</em>
            </div>
            <div className="dashboard-legend-list">
              {sourceMix.items.map((item) => (
                <span className="dashboard-hover-target" key={item.label} tabIndex={0}>
                  <i style={{ background: item.color }} />
                  {item.label}
                  <strong>{item.value}</strong>
                  <em className="dashboard-chart-tooltip">
                    {item.label}: {item.value} video{item.value === 1 ? "" : "s"}
                  </em>
                </span>
              ))}
            </div>
          </div>
        </article>

        <article className="panel dashboard-card dashboard-wide-card">
          <div className="panel-heading">
            <div>
              <h2>Publication Activity</h2>
              <span className="muted">Published records synced over the last 7 days</span>
            </div>
          </div>
          <div className="dashboard-activity-chart" aria-label="Seven day publication activity">
            {activitySeries.map((item) => (
              <div className="dashboard-activity-column dashboard-hover-target" key={item.key} tabIndex={0}>
                <span style={{ height: `${item.percent}%` }} title={`${item.value} records on ${item.label}`} />
                <small>{item.label}</small>
                <strong>{item.value}</strong>
                <em className="dashboard-chart-tooltip">
                  {item.fullLabel}: {item.value} published record{item.value === 1 ? "" : "s"}
                </em>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="dashboard-report-grid">
        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>Channel Report</h2>
              <span className="muted">{activePublications.length} active publication records</span>
            </div>
            <button type="button" onClick={() => setActiveView("Published Videos")}>
              Open library
            </button>
          </div>
          <div className="dashboard-platform-list">
            {platformReports.length === 0 ? (
              <div className="empty-inline">No published channel records yet.</div>
            ) : (
              platformReports.map((report) => (
                <div className="dashboard-platform-row dashboard-hover-target" key={report.id} tabIndex={0}>
                  <span>
                    <i style={{ background: report.color }} />
                    <strong>{report.label}</strong>
                    <small>{report.count} video records</small>
                    {report.topVideo && (
                      <small>
                        Top: {report.topVideo.title} ({formatNumber(report.topVideo.views)} views)
                      </small>
                    )}
                  </span>
                  <div className="dashboard-platform-stats">
                    <strong>{formatNumber(report.views)}</strong>
                    <small>views</small>
                  </div>
                  <div className="dashboard-platform-stats">
                    <strong>{formatNumber(report.likes)}</strong>
                    <small>likes</small>
                  </div>
                  <em className="dashboard-chart-tooltip">
                    {report.label}: {formatNumber(report.views)} views, {formatNumber(report.likes)} likes
                    {report.topVideo ? `; top video ${report.topVideo.title}` : ""}
                  </em>
                </div>
              ))
            )}
          </div>
        </article>

        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>User Report</h2>
              <span className="muted">{userReport.total} signed-in users tracked</span>
            </div>
            <button type="button" onClick={() => setActiveView("Users")}>
              Manage
            </button>
          </div>
          <div className="dashboard-user-summary">
            <span className="dashboard-hover-target" tabIndex={0}>
              <strong>{userReport.admins}</strong>
              <small>Admins</small>
              <em className="dashboard-chart-tooltip">Users with full admin access</em>
            </span>
            <span className="dashboard-hover-target" tabIndex={0}>
              <strong>{userReport.anonymous}</strong>
              <small>Anonymous</small>
              <em className="dashboard-chart-tooltip">Signed-in users without admin access</em>
            </span>
            <span className="dashboard-hover-target" tabIndex={0}>
              <strong>{userReport.recentSignIns}</strong>
              <small>7-day logins</small>
              <em className="dashboard-chart-tooltip">Users with a recorded login in the last 7 days</em>
            </span>
            <span className="dashboard-hover-target" tabIndex={0}>
              <strong>{userReport.protectedUsers}</strong>
              <small>Protected</small>
              <em className="dashboard-chart-tooltip">Owner accounts that cannot be changed or deleted</em>
            </span>
          </div>
          <div className="dashboard-user-list">
            {userReport.recentUsers.length === 0 ? (
              <div className="empty-inline">No signed-in users yet.</div>
            ) : (
              userReport.recentUsers.map((user) => (
                <div className="dashboard-user-row" key={user.id}>
                  <span>
                    <strong>{userDisplayName(user)}</strong>
                    <small>{user.email ?? user.id}</small>
                  </span>
                  <StatusBadge status={user.role ?? "anonymous"} />
                  <time>{userLastSeen(user)}</time>
                </div>
              ))
            )}
          </div>
        </article>
      </section>

      <section className="dashboard-report-grid">
        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>Top Videos By Views</h2>
              <span className="muted">Highest-hit published videos across channels</span>
            </div>
            <button type="button" onClick={() => setActiveView("Published Videos")}>
              Open library
            </button>
          </div>
          <div className="dashboard-top-video-list">
            {topVideos.length === 0 ? (
              <div className="empty-inline">No view data has been synced yet.</div>
            ) : (
              topVideos.map((video, index) => (
                <button
                  className="dashboard-top-video-row dashboard-hover-target"
                  key={video.id}
                  type="button"
                  onClick={() => setActiveView("Published Videos")}
                >
                  <span className="dashboard-rank">{index + 1}</span>
                  <span>
                    <strong>{video.title}</strong>
                    <small>
                      {video.platformLabel} - {video.status}
                    </small>
                  </span>
                  <div className="dashboard-platform-stats">
                    <strong>{formatNumber(video.views)}</strong>
                    <small>views</small>
                  </div>
                  <div className="dashboard-platform-stats">
                    <strong>{formatNumber(video.likes)}</strong>
                    <small>likes</small>
                  </div>
                  <em className="dashboard-chart-tooltip">
                    {video.title}: {formatNumber(video.views)} views and {formatNumber(video.likes)} likes on{" "}
                    {video.platformLabel}
                  </em>
                </button>
              ))
            )}
          </div>
        </article>

        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>Priority Work</h2>
              <span className="muted">Review and publishing actions first</span>
            </div>
            <button type="button" onClick={() => setActiveView("Content Queue")}>
              Open queue
            </button>
          </div>
          <div className="compact-list">
            {priorityJobs.length === 0 ? (
              <div className="empty-inline">No priority jobs.</div>
            ) : (
              priorityJobs.map((job) => (
                <button
                  className="compact-row"
                  key={job.id}
                  type="button"
                  onClick={() => {
                    setSelectedJobId(job.id);
                    setActiveView("Review");
                  }}
                >
                  <span>
                    <strong>{job.title}</strong>
                    <small>{job.stage}</small>
                  </span>
                  <StatusBadge status={job.status} />
                </button>
              ))
            )}
          </div>
        </article>
      </section>

      <section className="dashboard-report-grid">
        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>Publishing Plans</h2>
              <span className="muted">{activePlans.length} active plans</span>
            </div>
            <button type="button" onClick={() => setActiveView("Content Queue")}>
              Manage
            </button>
          </div>
          <div className="compact-list">
            {duePlans.length === 0 ? (
              <div className="empty-inline">No publishing plans.</div>
            ) : (
              duePlans.map((plan) => (
                <div className="compact-row static-row" key={plan.id}>
                  <span>
                    <strong>{plan.title}</strong>
                    <small>
                      {plan.platforms.join(", ")} at {plan.scheduledAt}
                    </small>
                  </span>
                  <StatusBadge status={plan.status} />
                </div>
              ))
            )}
          </div>
        </article>

        <article className="panel dashboard-card">
          <div className="panel-heading">
            <div>
              <h2>Recent Activity</h2>
              <span className="muted">Latest content, plan, and channel updates</span>
            </div>
          </div>
          <div className="dashboard-activity-list">
            {recentActivity.length === 0 ? (
              <div className="empty-inline">No recent activity yet.</div>
            ) : (
              recentActivity.map((item) => (
                <div className="dashboard-activity-row" key={`${item.type}-${item.id}`}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <time>{item.timeLabel}</time>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </div>
  );
}

function buildContentFlow(jobs) {
  const total = Math.max(1, jobs.length);
  return FLOW_STATUSES.map((item) => {
    const value = jobs.filter((job) => job.status === item.key).length;
    return {
      ...item,
      value,
      percent: Math.max(value > 0 ? 7 : 0, Math.round((value / total) * 100))
    };
  });
}

function buildSourceMix(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    const label = sourceLabel(job);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const items = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label, value], index) => ({
      label,
      value,
      color: SOURCE_COLORS[index % SOURCE_COLORS.length]
    }));

  if (items.length === 0) {
    return {
      items: [{ label: "No videos", value: 0, color: "#d8dee4" }],
      background: "conic-gradient(#d8dee4 0deg 360deg)"
    };
  }

  let start = 0;
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const segments = items.map((item) => {
    const degrees = total > 0 ? (item.value / total) * 360 : 0;
    const segment = `${item.color} ${start}deg ${start + degrees}deg`;
    start += degrees;
    return segment;
  });

  return {
    items,
    background: `conic-gradient(${segments.join(", ")})`
  };
}

function buildPlatformReports(publications) {
  const reports = new Map();
  for (const publication of publications) {
    const id = platformId(publication.platform);
    const views = publicationMetric(publication, "view");
    const likes = publicationMetric(publication, "like");
    const current = reports.get(id) ?? {
      id,
      label: platformDisplayLabel(publication.platform),
      count: 0,
      views: 0,
      likes: 0,
      topVideo: null,
      color: PLATFORM_COLORS[id] ?? PLATFORM_COLORS.unknown
    };
    current.count += 1;
    current.views += views;
    current.likes += likes;
    if (
      views > 0 &&
      (!current.topVideo || views > current.topVideo.views || (views === current.topVideo.views && likes > current.topVideo.likes))
    ) {
      current.topVideo = publicationSummary(publication, { views, likes });
    }
    reports.set(id, current);
  }
  return [...reports.values()].sort((left, right) => right.count - left.count || right.views - left.views);
}

function buildTopPublishedVideos(publications) {
  return publications
    .map((publication) =>
      publicationSummary(publication, {
        views: publicationMetric(publication, "view"),
        likes: publicationMetric(publication, "like")
      })
    )
    .filter((publication) => publication.views > 0)
    .sort((left, right) => right.views - left.views || right.likes - left.likes);
}

function buildActivitySeries(publications) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return {
      key: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString(undefined, { weekday: "short" }),
      fullLabel: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: 0
    };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));
  for (const publication of publications) {
    const date = publicationDate(publication);
    if (!date) continue;
    const key = date.toISOString().slice(0, 10);
    const day = byKey.get(key);
    if (day) {
      day.value += 1;
    }
  }
  const max = Math.max(1, ...days.map((day) => day.value));
  return days.map((day) => ({
    ...day,
    percent: Math.max(day.value > 0 ? 10 : 3, Math.round((day.value / max) * 100))
  }));
}

function buildPublishHealth(activePlans, activeAttempts, activePublications) {
  const records = [...activePlans, ...activeAttempts, ...activePublications];
  const values = [
    {
      label: "Queued",
      tone: "blue",
      value: records.filter((record) => ["draft", "approved", "queued", "retrying"].includes(record.status)).length
    },
    {
      label: "Processing",
      tone: "amber",
      value: records.filter((record) => ["publishing", "uploading", "processing", "delete_requested"].includes(record.status)).length
    },
    {
      label: "Published",
      tone: "green",
      value: records.filter((record) => record.status === "published").length
    },
    {
      label: "Failed",
      tone: "red",
      value: records.filter((record) => ["failed", "partial_failed"].includes(record.status)).length
    }
  ];
  const total = Math.max(1, values.reduce((sum, item) => sum + item.value, 0));
  return {
    total: records.length,
    active: values.find((item) => item.label === "Processing")?.value ?? 0,
    failed: values.find((item) => item.label === "Failed")?.value ?? 0,
    segments: values.map((item) => ({
      ...item,
      percent: Math.max(item.value > 0 ? 6 : 0, Math.round((item.value / total) * 100))
    }))
  };
}

function buildAccountStats(accounts) {
  const connected = accounts.filter((account) => ["connected", "configured"].includes(String(account.status ?? "").toLowerCase())).length;
  const attention = accounts.filter((account) =>
    ["disconnected", "oauth_pending", "reconnecting"].includes(String(account.status ?? "").toLowerCase()) ||
    ["refresh failed", "disconnected"].includes(String(account.tokenHealth ?? "").toLowerCase())
  ).length;
  return { connected, attention };
}

function buildUserReport(users) {
  const activeUsers = users.filter((user) => String(user.status ?? "").toLowerCase() !== "deleted");
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentUsers = [...activeUsers]
    .sort((left, right) => parseTime(userLastSeen(right)) - parseTime(userLastSeen(left)))
    .slice(0, 4);

  return {
    total: activeUsers.length,
    admins: activeUsers.filter((user) => user.role === "admin").length,
    anonymous: activeUsers.filter((user) => user.role !== "admin").length,
    protectedUsers: activeUsers.filter((user) => user.immutable).length,
    recentSignIns: activeUsers.filter((user) => parseTime(user.lastLoginAt) >= sevenDaysAgo).length,
    recentUsers
  };
}

function buildRecentActivity({ jobs, activePlans, publications }) {
  const jobItems = jobs.map((job) => ({
    type: "job",
    id: job.id,
    title: job.title,
    detail: `Content ${job.status.replaceAll("_", " ")}`,
    time: parseTime(job.updatedAt),
    timeLabel: job.updatedAt ?? "Unknown"
  }));
  const planItems = activePlans.map((plan) => ({
    type: "plan",
    id: plan.id,
    title: plan.title,
    detail: `${plan.platforms.join(", ")} publish plan`,
    time: parseTime(plan.updatedAt ?? plan.createdAt),
    timeLabel: plan.updatedAt ?? plan.createdAt ?? "Unknown"
  }));
  const publicationItems = publications.map((publication) => ({
    type: "publication",
    id: publication.id,
    title: publication.title || publication.providerPostId || publication.id,
    detail: `${platformDisplayLabel(publication.platform)} ${publication.status}`,
    time: parseTime(publication.updatedAt ?? publication.publishedAt),
    timeLabel: publication.updatedAt ?? publication.publishedAt ?? "Unknown"
  }));

  return [...jobItems, ...planItems, ...publicationItems].sort((left, right) => right.time - left.time);
}

function sourceLabel(job) {
  const sourceType = String(job.sourceType ?? "").toLowerCase();
  if (sourceType.includes("heygen")) return "HeyGen";
  if (sourceType.includes("video_upload")) return "Uploads";
  if (sourceType.includes("youtube")) return "YouTube imports";
  if (sourceType.includes("external")) return "Channel imports";
  return job.video?.provider ?? "Manual";
}

function publicationSummary(publication, metrics) {
  return {
    id: publication.id,
    title: publicationTitle(publication),
    platformLabel: platformDisplayLabel(publication.platform),
    status: publication.status ?? "unknown",
    views: metrics.views,
    likes: metrics.likes
  };
}

function publicationTitle(publication) {
  const metadata = publication.metadata ?? {};
  return (
    publication.title ||
    metadata.title ||
    metadata.youtube?.response?.snippet?.title ||
    metadata.youtube?.snippet?.title ||
    publication.providerPostId ||
    publication.id ||
    "Untitled video"
  );
}

function userDisplayName(user) {
  return user.displayName || user.email || user.id || "Unknown user";
}

function userLastSeen(user) {
  return user.lastLoginAt ?? user.updatedAt ?? "Not recorded";
}

function sumPublicationMetric(publications, metric) {
  return publications.reduce((sum, publication) => sum + publicationMetric(publication, metric), 0);
}

function publicationMetric(publication, metric) {
  const metadata = publication.metadata ?? {};
  if (metric === "view") {
    return toNumber(
      metadata.statistics?.viewCount ??
        metadata.youtube?.response?.statistics?.viewCount ??
        metadata.youtube?.statistics?.viewCount ??
        publication.viewCount
    );
  }
  return toNumber(
    metadata.statistics?.likeCount ??
      metadata.youtube?.response?.statistics?.likeCount ??
      metadata.youtube?.statistics?.likeCount ??
      publication.likeCount
  );
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value).trim().toLowerCase().replace(/,/g, "");
  const multiplier = normalized.endsWith("k") ? 1000 : normalized.endsWith("m") ? 1000000 : 1;
  const numeric = Number.parseFloat(normalized.replace(/[km]$/, ""));
  return Number.isFinite(numeric) ? Math.round(numeric * multiplier) : 0;
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return new Intl.NumberFormat(undefined, { notation: numeric >= 10000 ? "compact" : "standard" }).format(numeric);
}

function publicationDate(publication) {
  const metadata = publication.metadata ?? {};
  return parseDate(
    metadata.publishedAt ??
      metadata.syncedAt ??
      metadata.youtube?.publishedAt ??
      metadata.youtube?.response?.snippet?.publishedAt ??
      publication.publishedAt ??
      publication.updatedAt
  );
}

function parseDate(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function parseTime(value) {
  if (value === "just now") return Date.now();
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function platformId(platform) {
  const normalized = String(platform ?? "").toLowerCase();
  if (normalized === "x" || normalized.includes("twitter")) return "x";
  if (normalized.includes("youtube")) return "youtube";
  if (normalized.includes("linkedin")) return "linkedin";
  if (normalized.includes("instagram")) return "instagram";
  if (normalized.includes("facebook")) return "facebook";
  if (normalized.includes("tiktok")) return "tiktok";
  return "unknown";
}

function platformDisplayLabel(platform) {
  const id = platformId(platform);
  const labels = {
    youtube: "YouTube",
    linkedin: "LinkedIn",
    x: "X / Twitter",
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
    unknown: "Unknown"
  };
  return labels[id];
}
