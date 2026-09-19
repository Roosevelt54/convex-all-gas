import { useScopeArgs } from "../community";
import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { isoAttr, relativePast, useEscape, useFocusTrap } from "../util";

type ActivityRow = FunctionReturnType<typeof api.activity.recent>[number];

const ACCENT_COUNT = 6;

/** Stable, non-cryptographic, purely presentational: the same name always gets the same hue. */
function hashName(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function accentVar(index: number): string {
  return `var(--accent-${((index % ACCENT_COUNT) + ACCENT_COUNT) % ACCENT_COUNT})`;
}

function initialsOf(handle: string): string {
  const parts = handle.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Absolute clock text, so a relative time is never the only information. */
function clockTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The organizer-side kinds get a small text label so a new, opened or cancelled shift stands out
 * in a feed of claims. The message itself is pre-rendered server-side and shown verbatim.
 */
const KIND_LABEL: Partial<Record<ActivityRow["kind"], { text: string; className: string }>> = {
  posted: { text: "new shift", className: "badge" },
  opened: { text: "now open", className: "badge badge--you" },
  cancelled: { text: "cancelled", className: "badge badge--full" },
};

function ActivityItem(props: { row: ActivityRow; now: number }): JSX.Element {
  const { row, now } = props;
  const glyphStyle = { "--glyph-bg": accentVar(hashName(row.actorName)) } as CSSProperties;
  const label = KIND_LABEL[row.kind];
  return (
    <li className="live__row">
      {/* Decorative: the actor's name is already inside the message text. */}
      <span className="glyph" aria-hidden="true" style={glyphStyle}>
        {initialsOf(row.actorName)}
      </span>
      <div>
        <p>{row.message}</p>
        <p className="live__when">
          <time dateTime={isoAttr(row.createdAt)}>
            {relativePast(row.createdAt, now)}
            <span className="sr-only"> ({clockTime(row.createdAt)})</span>
          </time>{" "}
          {label !== undefined ? <span className={label.className}>{label.text}</span> : null}{" "}
          {row.isSim ? <span className="badge badge--sim">sim</span> : null}
        </p>
      </div>
    </li>
  );
}

function ActivityDrawer(props: { now: number; onClose: () => void }): JSX.Element {
  const { now, onClose } = props;
  const scopeArgs = useScopeArgs();
  // Paginated so the drawer can show the whole history without unbounding the ticker.
  const { results, status, loadMore } = usePaginatedQuery(
    api.activity.page,
    scopeArgs,
    { initialNumItems: 30 },
  );
  const trapRef = useFocusTrap(true);
  useEscape(onClose, true);

  const canLoadMore = status === "CanLoadMore";

  return (
    <div className="backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-drawer-title"
        ref={trapRef}
      >
        <div className="sheet__head">
          <h2 id="activity-drawer-title">All activity</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
            <span className="sr-only"> the all-activity drawer</span>
          </button>
        </div>

        {status === "LoadingFirstPage" ? (
          <p className="empty">Loading the activity history&hellip;</p>
        ) : results.length === 0 ? (
          <p className="empty">Nothing has been recorded yet.</p>
        ) : (
          <ul className="live" role="list" aria-label="All activity, newest first">
            {results.map((row) => (
              <ActivityItem key={row._id} row={row} now={now} />
            ))}
          </ul>
        )}

        <div className="row">
          <button
            type="button"
            className="btn btn--secondary"
            aria-disabled={canLoadMore ? undefined : true}
            aria-describedby="activity-drawer-more-note"
            onClick={canLoadMore ? () => loadMore(30) : undefined}
          >
            Load 30 more
          </button>
          <span className="muted tnum" id="activity-drawer-more-note">
            {status === "Exhausted"
              ? `All ${results.length} entries are shown — there is no more history.`
              : status === "LoadingMore"
                ? "Loading the next 30 entries…"
                : `${results.length} entries shown.`}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function LiveRail(props: { now: number }): JSX.Element {
  const { now } = props;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rows = useQuery(api.activity.recent, useScopeArgs());

  return (
    <aside className="card" id="live-activity" aria-label="Live activity" tabIndex={-1}>
      <div className="stack">
        <h2 className="fieldset__legend">Live activity</h2>

        {rows === undefined ? (
          <p className="empty">Connecting to the live feed&hellip;</p>
        ) : rows.length === 0 ? (
          <p className="empty">
            Nothing has happened yet. Claim a spot and it shows up here immediately.
          </p>
        ) : (
          /* aria-live is OFF on purpose. A board engineered to change every few seconds
             must not interrupt a screen-reader user every few seconds; only the user's
             OWN outcomes are announced, through the app's polite status region. */
          <ul
            className="live"
            role="list"
            aria-live="off"
            aria-label="Recent activity, newest first"
          >
            {rows.map((row) => (
              <ActivityItem key={row._id} row={row} now={now} />
            ))}
          </ul>
        )}

        <button type="button" className="btn btn--secondary" onClick={() => setDrawerOpen(true)}>
          See all activity
        </button>
      </div>

      {drawerOpen ? <ActivityDrawer now={now} onClose={() => setDrawerOpen(false)} /> : null}
    </aside>
  );
}
