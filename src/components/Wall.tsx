import type { CSSProperties, JSX } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { absoluteWindow, isoAttr, relativePast, relativeStart } from "../util";

type Snapshot = FunctionReturnType<typeof api.board.snapshot>;
type ShiftRow = Snapshot["shifts"][number];

const ACCENT_COUNT = 6;
const URGENT_LIMIT = 9;
const FEED_LIMIT = 12;

function accentStyle(index: number): CSSProperties {
  return { "--shift-accent": `var(--accent-${index % ACCENT_COUNT})` } as CSSProperties;
}

function spotsLeft(s: ShiftRow): number {
  return Math.max(0, s.capacity - s.filledCount);
}

/**
 * Read-only wall display at #/wall — the screen a judge photographs, and the
 * deterministic two-window proof that owes nothing to the simulator.
 *
 * It reuses the same subscriptions as the board; there is no wall-specific backend.
 * App already sends the wall-scoped presence heartbeat, so none is sent here.
 */
export default function Wall({ now }: { deviceKey: string; now: number }): JSX.Element {
  const snapshot = useQuery(api.board.snapshot, {});
  const activity = useQuery(api.activity.recent, {});
  const presence = useQuery(api.presence.onScope, { scope: "wall" });

  const backHref = "#/";

  if (snapshot === undefined) {
    return (
      <main className="wall" aria-busy="true">
        <p className="wall__label">Connecting to the board…</p>
        <a className="btn btn--secondary" href={backHref}>
          Back to board
        </a>
      </main>
    );
  }

  const projectById = new Map(snapshot.projects.map((p) => [p._id, p]));

  // Most urgent first: open shifts that have not ended and still need people,
  // fewest spots left, then soonest. Full shifts need nobody, so they are excluded.
  const urgent = snapshot.shifts
    .filter((s) => s.status === "open" && s.endsAt > now && spotsLeft(s) > 0)
    .sort((a, b) => spotsLeft(a) - spotsLeft(b) || a.startsAt - b.startsAt)
    .slice(0, URGENT_LIMIT);

  const { spotsLeftTotal, criticalCount, projectCount } = snapshot.stats;
  const hereNow = presence?.count ?? 0;

  return (
    <main className="wall" aria-labelledby="wall-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 id="wall-title" className="wordmark">
          <span className="wordmark__mark" aria-hidden="true" />
          Crewcall live
        </h1>
        <div className="row">
          <span className="badge tnum">
            {hereNow} {hereNow === 1 ? "person" : "people"} here now
          </span>
          <a className="btn btn--secondary btn--sm" href={backHref}>
            Back to board
          </a>
        </div>
      </div>

      <section aria-label="Totals" className="row" style={{ gap: "var(--sp-6)", alignItems: "flex-end" }}>
        <div>
          <p className="wall__number">{spotsLeftTotal}</p>
          <p className="wall__label">
            {spotsLeftTotal === 1 ? "spot left" : "spots left"} this week
          </p>
        </div>
        <div className="stack" style={{ gap: "var(--sp-1)" }}>
          <p className="wall__shift-count tnum">{criticalCount}</p>
          <p className="muted">
            {criticalCount === 1 ? "shift" : "shifts"} critical across {projectCount}{" "}
            {projectCount === 1 ? "project" : "projects"}
          </p>
        </div>
      </section>

      <section aria-labelledby="wall-urgent">
        <h2 id="wall-urgent" className="wall__label" style={{ marginBottom: "var(--sp-3)" }}>
          Most needed
        </h2>
        {urgent.length === 0 ? (
          <p className="empty">Every upcoming shift is fully staffed.</p>
        ) : (
          <ul className="wall__grid">
            {urgent.map((s) => {
              const project = projectById.get(s.projectId);
              const left = spotsLeft(s);
              const pct = Math.round((s.filledCount / s.capacity) * 100);
              return (
                <li key={s._id} className="wall__shift" style={accentStyle(project?.accentIndex ?? 0)}>
                  <p className="shift__project">{project?.title ?? "Project"}</p>
                  <h3 className="shift__title">{s.title}</h3>
                  <p className="muted">
                    <time dateTime={isoAttr(s.startsAt)}>
                      {relativeStart(s.startsAt, s.endsAt, now)} · {absoluteWindow(s.startsAt, s.endsAt)}
                    </time>
                  </p>
                  <p className="wall__shift-count">
                    {left} <span className="wall__label" style={{ fontSize: "var(--fs-base)" }}>left</span>
                  </p>
                  <span
                    className="meter"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={s.capacity}
                    aria-valuenow={s.filledCount}
                    aria-valuetext={`${s.filledCount} of ${s.capacity} spots filled, ${left} left`}
                    aria-label={`Capacity for ${s.title}`}
                  >
                    <span className="meter__fill" style={{ width: `${pct}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="wall-feed">
        <h2 id="wall-feed" className="wall__label" style={{ marginBottom: "var(--sp-3)" }}>
          Happening now
        </h2>
        {/* A wall is watched, not read aloud: an assertive feed here would spam a
            screen reader on every neighbour's click, so it is deliberately not live. */}
        <ul className="card live" aria-live="off" style={{ maxHeight: "none" }}>
          {activity === undefined ? (
            <li className="muted">Loading activity…</li>
          ) : activity.length === 0 ? (
            <li className="muted">No activity yet.</li>
          ) : (
            activity.slice(0, FEED_LIMIT).map((row) => (
              <li key={row._id} className="live__row">
                <time className="live__when" dateTime={isoAttr(row.createdAt)}>
                  {relativePast(row.createdAt, now)}
                </time>
                <span>
                  {row.message}
                  {row.isSim ? (
                    <>
                      {" "}
                      <span className="badge badge--sim">sim</span>
                    </>
                  ) : null}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
    </main>
  );
}
