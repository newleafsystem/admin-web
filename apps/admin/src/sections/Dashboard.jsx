import { StatusBadge } from "../components/common.jsx";
import { isArchivedPublishPlan, isReviewableJob } from "../utils.js";

export function Dashboard({ jobs, metrics, publishPlans, setActiveView, setSelectedJobId }) {
  const highRiskJobs = jobs.filter((job) => job.risk === "high" && isReviewableJob(job));
  const duePlans = publishPlans.filter((plan) => plan.status !== "published" && !isArchivedPublishPlan(plan));
  const priorityJobs = Array.from(
    new Map([...highRiskJobs, ...jobs.filter(isReviewableJob)].map((job) => [job.id, job])).values()
  ).slice(0, 4);

  return (
    <div className="view-stack">
      <section className="metric-grid" aria-label="Operational metrics">
        {metrics.map((metric) => (
          <article className={`metric metric-${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </article>
        ))}
      </section>

      <section className="split-grid">
        <div className="panel">
          <div className="panel-heading">
            <h2>Priority Jobs</h2>
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
        </div>

        <div className="panel">
          <div className="panel-heading">
            <h2>Publishing Plans</h2>
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
                    <small>{plan.platforms.join(", ")} at {plan.scheduledAt}</small>
                  </span>
                  <StatusBadge status={plan.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
