import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getHealth, getReadiness } from "../api.ts";
import { Button } from "../ui/button.tsx";

type Health = Awaited<ReturnType<typeof getHealth>>;
type Readiness = Awaited<ReturnType<typeof getReadiness>>;
type Overall = "loading" | "unavailable" | "degraded" | "ok";
type BadgeState = "loading" | "ok" | "degraded" | "error";

const overviews: Record<
  Overall,
  { heading: string; text: string; icon: string; tone: string }
> = {
  loading: {
    heading: "Checking services",
    text: "Waiting for the API to respond.",
    icon: "…",
    tone: "success",
  },
  unavailable: {
    heading: "Some checks are unavailable",
    text: "A check could not be completed. Check your connection and try again.",
    icon: "!",
    tone: "danger",
  },
  degraded: {
    heading: "Attention needed",
    text: "One or more dependencies need attention.",
    icon: "!",
    tone: "warning",
  },
  ok: {
    heading: "All checks operational",
    text: "The API is responding and its readiness check passed.",
    icon: "✓",
    tone: "success",
  },
};
const badgeLabels: Record<BadgeState, string> = {
  loading: "Checking",
  ok: "Operational",
  degraded: "Degraded",
  error: "Unavailable",
};
const unreachable = "Unable to reach or validate the API";

function StatusBadge({ state }: { state: BadgeState }) {
  return (
    <span className={`status-badge status-${state}`}>
      <span aria-hidden="true">●</span> {badgeLabels[state]}
    </span>
  );
}

function badgeOf(query: UseQueryResult, degraded = false): BadgeState {
  if (query.isPending) return "loading";
  if (query.isError) return "error";
  return degraded ? "degraded" : "ok";
}
function healthDetail(health: UseQueryResult<Health>) {
  if (health.isPending) return "Waiting for response";
  if (health.isError) return unreachable;
  return `Uptime: ${String(Math.floor(health.data.uptimeSeconds))} seconds`;
}
function readinessDetail(readiness: UseQueryResult<Readiness>) {
  if (readiness.isPending) return "Waiting for response";
  if (readiness.isError) return unreachable;
  const { dependencies } = readiness.data;
  if (dependencies.length === 0) return "No dependencies declared";
  const up = dependencies.filter((item) => item.status === "up").length;
  return `${String(up)} of ${String(dependencies.length)} dependencies up`;
}

function CheckCard({
  icon,
  title,
  description,
  state,
  detail,
  endpoint,
}: {
  icon: string;
  title: string;
  description: string;
  state: BadgeState;
  detail: string;
  endpoint: string;
}) {
  return (
    <article className="check-card">
      <div className="check-top">
        <div className="check-icon" aria-hidden="true">
          {icon}
        </div>
        <StatusBadge state={state} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="check-detail">{detail}</div>
      <code>{endpoint}</code>
    </article>
  );
}

function Overview({ overall }: { overall: Overall }) {
  const overview = overviews[overall];
  return (
    <section
      className="overview-card"
      aria-labelledby="overview-heading"
      aria-live="polite"
    >
      <div className={`overview-icon ${overview.tone}`} aria-hidden="true">
        {overview.icon}
      </div>
      <div>
        <p className="eyebrow">CURRENT OVERVIEW</p>
        <h2 id="overview-heading">{overview.heading}</h2>
        <p>{overview.text}</p>
      </div>
      <span className="live-label">
        <span className="live-dot" /> LIVE CHECKS
      </span>
    </section>
  );
}

function Dependencies({ readiness }: { readiness: Readiness | undefined }) {
  if (!readiness || readiness.dependencies.length === 0) return null;
  return (
    <section className="dependency-card">
      <h2>Dependencies</h2>
      <ul>
        {readiness.dependencies.map((dependency) => (
          <li key={dependency.name}>
            <span>{dependency.name}</span>
            <StatusBadge
              state={dependency.status === "up" ? "ok" : "degraded"}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function overallOf(
  health: UseQueryResult<Health>,
  readiness: UseQueryResult<Readiness>,
): Overall {
  if (health.isPending || readiness.isPending) return "loading";
  if (health.isError || readiness.isError) return "unavailable";
  return readiness.data.status === "not_ready" ? "degraded" : "ok";
}

/** Live view of the API health and readiness checks. */
export function StatusPage() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 30_000,
  });
  const readiness = useQuery({
    queryKey: ["readiness"],
    queryFn: getReadiness,
    refetchInterval: 30_000,
  });
  return (
    <div className="content-wrap">
      <div className="page-breadcrumb">
        WORKSPACE <span>/</span> SYSTEM STATUS
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">YOUR INSTALLATION</p>
          <h1>System status</h1>
          <p className="page-subtitle">
            A live view of your Esuno API and its dependencies.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            void health.refetch();
            void readiness.refetch();
          }}
          disabled={health.isFetching || readiness.isFetching}
        >
          <span aria-hidden="true">↻</span> Refresh checks
        </Button>
      </div>
      <Overview overall={overallOf(health, readiness)} />
      <div className="section-heading">
        <div>
          <p className="eyebrow">SERVICE CHECKS</p>
          <h2>API health</h2>
          <p>Checks refresh automatically every 30 seconds.</p>
        </div>
      </div>
      <div className="checks-grid">
        <CheckCard
          icon="♡"
          title="Liveness"
          description="Confirms the API process is responding."
          state={badgeOf(health)}
          detail={healthDetail(health)}
          endpoint="GET /api/health"
        />
        <CheckCard
          icon="◈"
          title="Readiness"
          description="Checks whether declared dependencies are available."
          state={badgeOf(readiness, readiness.data?.status === "not_ready")}
          detail={readinessDetail(readiness)}
          endpoint="GET /api/ready"
        />
      </div>
      <Dependencies readiness={readiness.data} />
      <p className="status-footnote">Status reflects these API checks only.</p>
    </div>
  );
}

/** Page for a product that the web app does not provide yet. */
export function ProductPlaceholder({ name }: { name: string }) {
  return (
    <div className="content-wrap">
      <div className="page-breadcrumb">
        WORKSPACE <span>/</span> {name.toUpperCase()}
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">PRODUCTS</p>
          <h1>{name}</h1>
          <p className="page-subtitle">
            {name} is not available in the web app yet.
          </p>
        </div>
      </div>
      <section className="empty-card">
        <div className="check-icon" aria-hidden="true">
          ◇
        </div>
        <h2>Coming later</h2>
        <p>
          This area is reserved for {name.toLowerCase()}. You can check your
          installation while it is being built.
        </p>
        <Button asChild variant="secondary">
          <Link to="/status">View system status</Link>
        </Button>
      </section>
    </div>
  );
}
