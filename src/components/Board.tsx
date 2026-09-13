import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, JSX } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import {
  absoluteWindow,
  isoAttr,
  prefersReducedMotion,
  relativePast,
  relativeStart,
} from "../util";
import Filters, { scoreNeed, type TimeWindow } from "./Filters";
import LiveRail from "./LiveRail";

type Snapshot = FunctionReturnType<typeof api.board.snapshot>;
type ShiftRow = Snapshot["shifts"][number];
type ProjectRow = Snapshot["projects"][number];
type Commitments = FunctionReturnType<typeof api.board.myCommitments>;
type CommitmentRow = Commitments["claims"][number];

/* Stable empty references so the memos below do not churn on every render. */
const NO_SHIFTS: ShiftRow[] = [];
const NO_PROJECTS: ProjectRow[] = [];
const NO_CLAIMS: CommitmentRow[] = [];

const ACCENT_COUNT = 6;
const HOUR = 3_600_000;
const SOON_MS = 6 * HOUR;
const MOVED_HIGHLIGHT_MS = 2_000;

function accentVar(index: number): string {
  return `var(--accent-${((index % ACCENT_COUNT) + ACCENT_COUNT) % ACCENT_COUNT})`;
}

/** Absolute clock text, so a relative time is never the only information. */
function clockTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function endOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Human phrase for the causal-attribution chip. `null` means "never touched by a person". */
function changePhrase(kind: ShiftRow["lastChangeKind"]): string | null {
  switch (kind) {
    case "claimed":
      return "took a spot";
    case "released":
      return "released a spot";
    case "promoted":
      return "was promoted";
    case "waitlisted":
      return "joined the waitlist";
    case "capacity_added":
      return "opened more spots";
    case "seeded":
      return null;
  }
}

/**
 * Urgency ordering. The rule is "spots remaining ascending, then soonest start" — but a
 * shift with zero spots remaining needs nobody, so full and cancelled shifts sort BELOW
 * every shift that still needs people rather than above them.
 */
function sortRank(shift: ShiftRow): number {
  if (shift.status === "cancelled") return 1_000_000;
  const spotsLeft = Math.max(0, shift.capacity - shift.filledCount);
  return spotsLeft === 0 ? 100_000 : spotsLeft;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** How many cards would move, appear or disappear if the pending order were applied. */
function countChanges(prev: readonly string[], next: readonly string[]): number {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  let moved = 0;
  next.forEach((id, i) => {
    const p = prev.indexOf(id);
    if (p !== -1 && p !== i) moved += 1;
  });
  const added = next.filter((id) => !prevSet.has(id)).length;
  const removed = prev.filter((id) => !nextSet.has(id)).length;
  return Math.max(1, moved + added + removed);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/* ------------------------------------------------------------------ card -- */

function ShiftCard(props: {
  shift: ShiftRow;
  project: ProjectRow | undefined;
  claim: CommitmentRow | undefined;
  now: number;
  moved: boolean;
  onOpen: (shiftId: string) => void;
}): JSX.Element {
  const { shift, project, claim, now, moved, onOpen } = props;

  const spotsLeft = Math.max(0, shift.capacity - shift.filledCount);
  const cancelled = shift.status === "cancelled";
  const full = !cancelled && spotsLeft === 0;
  const projectTitle = project?.title ?? "Community project";

  // The accent stripe is decorative reinforcement; the project name is always text.
  const cardStyle = { "--shift-accent": accentVar(project?.accentIndex ?? 0) } as CSSProperties;

  const whenRelative = relativeStart(shift.startsAt, shift.endsAt, now);
  const whenAbsolute = absoluteWindow(shift.startsAt, shift.endsAt);
  const meterText = `${shift.filledCount} of ${shift.capacity} ${plural(
    shift.capacity,
    "spot",
    "spots",
  )} filled, ${spotsLeft} left`;
  const fillPct = shift.capacity > 0 ? (shift.filledCount / shift.capacity) * 100 : 0;

  const capacityBadge = cancelled
    ? "Cancelled"
    : full
      ? shift.waitlistCount > 0
        ? `Full · ${shift.waitlistCount} waiting`
        : "Full"
      : `${spotsLeft} left`;
  const capacityBadgeClass =
    cancelled || full ? "badge badge--full" : spotsLeft <= 2 ? "badge badge--urgent" : "badge";

  const timingBadge = shift.startsAt - now <= SOON_MS ? whenRelative : null;

  const youBadge = claim
    ? claim.kind === "spot"
      ? `You're in · spot ${claim.position + 1}`
      : `Waitlist #${claim.waitlistRank ?? claim.position + 1}`
    : null;

  const phrase = changePhrase(shift.lastChangeKind);

  const claimVerb = cancelled
    ? "Claim a spot"
    : claim
      ? "Manage your spot"
      : full
        ? "Join the waitlist"
        : "Claim a spot";

  const headingId = `shift-${shift._id}-title`;
  const cancelNoteId = `shift-${shift._id}-cancelled`;

  return (
    <li>
      <article
        className={`card shift${moved ? " shift--moved" : ""}`}
        style={cardStyle}
        aria-labelledby={headingId}
        data-shift-id={shift._id}
      >
        <div className="shift__head">
          <div>
            <h3 className="shift__title" id={headingId}>
              {shift.title}
            </h3>
            <p className="shift__project">{projectTitle}</p>
          </div>
          <div className="row">
            <span className={capacityBadgeClass}>{capacityBadge}</span>
            {timingBadge ? <span className="badge badge--urgent">{timingBadge}</span> : null}
            {youBadge ? <span className="badge badge--you">{youBadge}</span> : null}
          </div>
        </div>

        <p className="shift__meta">
          {/* Relative time is never the only information: the absolute window is right there. */}
          <time dateTime={isoAttr(shift.startsAt)}>
            {whenRelative} · {whenAbsolute}
          </time>
          <span>Meet at {shift.meetPoint}</span>
          <span>{shift.role}</span>
          <span>{shift.skillTag}</span>
        </p>

        <div className="stack">
          {/* Decorative only — shape differs (solid disc vs outline ring); the meter carries
              the meaning, so nothing is double-exposed to assistive technology. */}
          <div className="pips" aria-hidden="true">
            {Array.from({ length: shift.capacity }, (_, i) => (
              <span key={i} className={`pip${i < shift.filledCount ? " pip--filled" : ""}`} />
            ))}
          </div>
          <div
            className="meter"
            role="progressbar"
            aria-label={`Spots filled at ${shift.title}`}
            aria-valuenow={shift.filledCount}
            aria-valuemin={0}
            aria-valuemax={shift.capacity}
            aria-valuetext={meterText}
          >
            <span className="meter__fill" style={{ width: `${fillPct}%` }} />
          </div>
        </div>

        <p className="attribution">
          <span>{phrase ? `${shift.lastChangeActorName} ${phrase} ` : "Posted to the board "}</span>
          <time dateTime={isoAttr(shift.lastChangeAt)}>
            {relativePast(shift.lastChangeAt, now)}
            <span className="sr-only"> ({clockTime(shift.lastChangeAt)})</span>
          </time>
          {shift.lastChangeIsSim ? <span className="badge badge--sim">sim</span> : null}
        </p>

        <div className="shift__foot">
          {/* Unavailable does NOT mean removed from the tab order: aria-disabled plus the
              adjacent sentence below, so the control stays focusable and explains itself. */}
          <button
            type="button"
            className="btn btn--primary"
            data-card-focus=""
            aria-disabled={cancelled ? true : undefined}
            aria-describedby={cancelled ? cancelNoteId : undefined}
            onClick={cancelled ? undefined : () => onOpen(shift._id)}
          >
            {claimVerb}
            <span className="sr-only">
              {" "}
              at {shift.title}, {projectTitle}, {whenAbsolute}, {meterText}
            </span>
          </button>

          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpen(shift._id)}>
            Details
            <span className="sr-only">
              {" "}
              for {shift.title}, {projectTitle}, {whenAbsolute}
            </span>
          </button>

          {cancelled ? (
            <span className="muted" id={cancelNoteId}>
              This shift was cancelled, so it cannot be claimed.
            </span>
          ) : null}
        </div>
      </article>
    </li>
  );
}

/* ----------------------------------------------------------------- board -- */

export default function Board(props: {
  deviceKey: string;
  now: number;
  announce: (msg: string) => void;
  onOpenShift: (shiftId: string) => void;
}): JSX.Element {
  const { deviceKey, now, announce, onOpenShift } = props;

  // TWO separate subscriptions, deliberately. "You" state costs one small query and never
  // widens the board read; both are live subscriptions, so nothing here ever polls.
  const snapshot = useQuery(api.board.snapshot, {});
  const mine = useQuery(api.board.myCommitments, deviceKey ? { deviceKey } : "skip");

  const shifts = snapshot?.shifts ?? NO_SHIFTS;
  const projects = snapshot?.projects ?? NO_PROJECTS;
  const claims = mine?.claims ?? NO_CLAIMS;

  // "This week" by default: the widest window, so the board is never empty on first paint.
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("week");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [needsPeopleOnly, setNeedsPeopleOnly] = useState(false);

  const projectsById = useMemo(() => {
    const map = new Map<string, ProjectRow>();
    for (const p of projects) map.set(p._id, p);
    return map;
  }, [projects]);

  const shiftsById = useMemo(() => {
    const map = new Map<string, ShiftRow>();
    for (const s of shifts) map.set(s._id, s);
    return map;
  }, [shifts]);

  const claimsByShift = useMemo(() => {
    const map = new Map<string, CommitmentRow>();
    for (const c of claims) map.set(c.shiftId, c);
    return map;
  }, [claims]);

  const skillTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of shifts) if (s.skillTag) set.add(s.skillTag);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [shifts]);

  // ALL filtering is client-side over the <= 60 rows already in the snapshot. No round trip.
  const visible = useMemo(() => {
    const horizon =
      timeWindow === "today"
        ? endOfToday(now)
        : timeWindow === "48h"
          ? now + 48 * HOUR
          : Number.POSITIVE_INFINITY;

    const list = shifts.filter((s) => {
      if (s.endsAt <= now) return false;
      if (s.startsAt > horizon) return false;
      if (selectedSkills.length > 0 && !selectedSkills.includes(s.skillTag)) return false;
      if (needsPeopleOnly && (s.status !== "open" || s.capacity - s.filledCount <= 0)) {
        return false;
      }
      return true;
    });

    list.sort((a, b) => {
      const ra = sortRank(a);
      const rb = sortRank(b);
      if (ra !== rb) return ra - rb;
      if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt;
      return a._id < b._id ? -1 : a._id > b._id ? 1 : 0; // deterministic tiebreak
    });
    return list;
  }, [shifts, now, timeWindow, selectedSkills, needsPeopleOnly]);

  const desired = useMemo(() => visible.map((s) => s._id as string), [visible]);

  /* --------------------------------------------------------------------- */
  /* REORDER DISCIPLINE                                                     */
  /*                                                                        */
  /* The displayed order lives in state; the desired order is derived from  */
  /* live data. While focus is inside the list the two are allowed to       */
  /* diverge: the pending order waits in a ref behind an                    */
  /* "Apply new order (N)" button and lands on blur or on click. Keyboard   */
  /* users never have a target move under them, and pointer users never     */
  /* have a card slide out from under the cursor.                           */
  /* --------------------------------------------------------------------- */

  const [displayed, setDisplayed] = useState<string[]>([]);
  const displayedRef = useRef<string[]>([]);
  const pendingRef = useRef<string[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [movedIds, setMovedIds] = useState<string[]>([]);

  const focusInsideRef = useRef(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const applyBtnRef = useRef<HTMLButtonElement | null>(null);
  const movedTimerRef = useRef<number | null>(null);
  const refocusIndexRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (movedTimerRef.current !== null) window.clearTimeout(movedTimerRef.current);
    };
  }, []);

  const applyOrder = useCallback((next: string[]) => {
    const prev = displayedRef.current;

    // If the card holding focus is about to disappear, remember where it was so focus can
    // land on its neighbour instead of falling to <body>.
    const active = document.activeElement;
    const card =
      active instanceof HTMLElement
        ? (active.closest("[data-shift-id]") as HTMLElement | null)
        : null;
    const activeId = card?.dataset.shiftId;
    if (activeId && !next.includes(activeId)) {
      refocusIndexRef.current = Math.max(0, prev.indexOf(activeId));
    }

    const moved = next.filter((id, i) => {
      const p = prev.indexOf(id);
      return p !== -1 && p !== i;
    });

    displayedRef.current = next;
    setDisplayed(next);
    pendingRef.current = null;
    setPendingCount(0);

    // Reduced motion: no FLIP animation, just an instant swap plus a 2s static outline.
    if (prefersReducedMotion() && moved.length > 0) {
      setMovedIds(moved);
      if (movedTimerRef.current !== null) window.clearTimeout(movedTimerRef.current);
      movedTimerRef.current = window.setTimeout(() => {
        setMovedIds([]);
        movedTimerRef.current = null;
      }, MOVED_HIGHLIGHT_MS);
    }
  }, []);

  useEffect(() => {
    const current = displayedRef.current;
    if (sameOrder(current, desired)) {
      if (pendingRef.current !== null) {
        pendingRef.current = null;
        setPendingCount(0);
      }
      return;
    }
    if (focusInsideRef.current) {
      pendingRef.current = desired;
      setPendingCount(countChanges(current, desired));
      return;
    }
    applyOrder(desired);
  }, [desired, applyOrder]);

  // Focus rescue: the element you were on was removed by someone else's action.
  useEffect(() => {
    const index = refocusIndexRef.current;
    if (index === null) return;
    refocusIndexRef.current = null;
    const buttons = listRef.current
      ? Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-card-focus]"))
      : [];
    const target = buttons[Math.min(index, buttons.length - 1)] ?? headingRef.current;
    target?.focus();
    announce("The shift you were on is no longer listed. Focus moved to the next shift.");
  }, [displayed, announce]);

  const onListFocus = useCallback(() => {
    focusInsideRef.current = true;
  }, []);

  const onListBlur = useCallback(
    (e: FocusEvent<HTMLUListElement>) => {
      const next = e.relatedTarget;
      if (next instanceof Node && e.currentTarget.contains(next)) return;
      // Moving to the Apply button must NOT auto-apply: the button would unmount between
      // mousedown and mouseup and the click would never fire.
      if (next !== null && next === applyBtnRef.current) return;
      focusInsideRef.current = false;
      if (pendingRef.current !== null) applyOrder(pendingRef.current);
    },
    [applyOrder],
  );

  const onApplyClick = useCallback(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    const n = pendingCount;
    applyOrder(pending);
    announce(`Order updated. ${n} ${plural(n, "shift", "shifts")} moved.`);
    headingRef.current?.focus();
  }, [applyOrder, announce, pendingCount]);

  const onApplyBlur = useCallback(() => {
    if (pendingRef.current !== null) applyOrder(pendingRef.current);
  }, [applyOrder]);

  /* ------------------------------------------------------------ rendering */

  const rendered = useMemo(() => {
    const out: ShiftRow[] = [];
    for (const id of displayed) {
      const s = shiftsById.get(id);
      if (s !== undefined) out.push(s);
    }
    return out;
  }, [displayed, shiftsById]);

  const toggleSkill = useCallback((tag: string) => {
    setSelectedSkills((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, []);

  const clearFilters = useCallback(() => {
    setTimeWindow("week");
    setSelectedSkills([]);
    setNeedsPeopleOnly(false);
  }, []);

  const onFindWhereNeeded = useCallback(() => {
    // Deterministic local scoring over data already in the client — see scoreNeed in
    // Filters.tsx. No AI, no API key, no network call.
    let best: ShiftRow | null = null;
    let bestScore = 0;
    for (const s of rendered) {
      const score = scoreNeed(s, now, selectedSkills);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best === null) {
      announce("No shift on the board still needs people with these filters.");
      return;
    }
    const spotsLeft = Math.max(0, best.capacity - best.filledCount);
    const projectTitle = projectsById.get(best.projectId)?.title ?? "a community project";
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-shift-id="${best._id}"] [data-card-focus]`,
    );
    node?.focus();
    announce(
      `${best.title} at ${projectTitle} needs you most — ${spotsLeft} ${plural(
        spotsLeft,
        "spot",
        "spots",
      )} left and it ${relativeStart(best.startsAt, best.endsAt, now).toLowerCase()}, ` +
        `${absoluteWindow(best.startsAt, best.endsAt)}.`,
    );
  }, [rendered, now, selectedSkills, announce, projectsById]);

  const loading = snapshot === undefined;

  return (
    <div className="shell">
      <div className="col col--filters">
        <Filters
          timeWindow={timeWindow}
          onTimeWindow={setTimeWindow}
          skills={skillTags}
          selectedSkills={selectedSkills}
          onToggleSkill={toggleSkill}
          needsPeopleOnly={needsPeopleOnly}
          onNeedsPeopleOnly={setNeedsPeopleOnly}
          onFindWhereNeeded={onFindWhereNeeded}
          shownCount={rendered.length}
          totalCount={shifts.length}
        />
      </div>

      <main className="col" aria-label="Shift board">
        <div className="stack">
          <div className="row">
            <h2 className="fieldset__legend" id="shift-list-heading" ref={headingRef} tabIndex={-1}>
              Open shifts
            </h2>
            <span className="muted tnum">
              {loading
                ? "Loading…"
                : `${rendered.length} ${plural(
                    rendered.length,
                    "shift",
                    "shifts",
                  )}, most urgent first`}
            </span>
          </div>

          {pendingCount > 0 ? (
            <button
              type="button"
              ref={applyBtnRef}
              className="btn btn--secondary"
              onClick={onApplyClick}
              onBlur={onApplyBlur}
            >
              Apply new order ({pendingCount})
              <span className="sr-only">
                {" "}
                — the board changed while you were reading it, so the list was held still
              </span>
            </button>
          ) : null}

          {loading ? (
            <p className="empty">Loading the board&hellip;</p>
          ) : rendered.length === 0 ? (
            <div className="card stack">
              <p>No shift matches these filters right now.</p>
              <p>
                <button type="button" className="btn btn--secondary" onClick={clearFilters}>
                  Clear all filters
                </button>
              </p>
            </div>
          ) : (
            <ul
              className="shift-list"
              id="shift-list"
              tabIndex={-1}
              role="list"
              aria-labelledby="shift-list-heading"
              ref={listRef}
              onFocus={onListFocus}
              onBlur={onListBlur}
            >
              {rendered.map((shift) => (
                <ShiftCard
                  key={shift._id}
                  shift={shift}
                  project={projectsById.get(shift.projectId)}
                  claim={claimsByShift.get(shift._id)}
                  now={now}
                  moved={movedIds.includes(shift._id)}
                  onOpen={onOpenShift}
                />
              ))}
            </ul>
          )}
        </div>
      </main>

      <div className="col col--live">
        <LiveRail now={now} />
      </div>
    </div>
  );
}
