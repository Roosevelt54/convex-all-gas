import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  absoluteWindow,
  isoAttr,
  relativePast,
  relativeStart,
  useEscape,
  useFocusTrap,
} from "../util";

/** Six accent tokens exist in styles.css; accentIndex/colorIndex can exceed that, so fold. */
const ACCENT_COUNT = 6;
/** A Convex document id rendered as a string is always this long. */
const ID_LENGTH = 32;
/** The judge's one-click promotion generator adds this many spots. */
const CAPACITY_DELTA = 2;
/** Mirrors MAX_CAPACITY in convex/shifts.ts, so the button can explain itself before it fails. */
const MAX_CAPACITY = 24;

function accentVars(index: number): CSSProperties {
  return { "--shift-accent": `var(--accent-${index % ACCENT_COUNT})` } as CSSProperties;
}

function glyphVars(colorIndex: number): CSSProperties {
  return { "--glyph-bg": `var(--accent-${colorIndex % ACCENT_COUNT})` } as CSSProperties;
}

/** A ConvexError surfaces as err.data = {code, message}. Never show a stack trace. */
function errorMessage(err: unknown): string {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Something went wrong. Try that again in a moment.";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The conflict outcome carries a start instant only, so absoluteWindow does not apply. */
function absolutePoint(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function listNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Stand-in id for the row an optimistic claim paints before the server answers. It is only ever
 * read as "you have something here"; the real claimId lands on settle a frame later.
 */
const OPTIMISTIC_CLAIM_ID = "optimistic" as Id<"claims">;

type Alternative = {
  shiftId: Id<"shifts">;
  title: string;
  startsAt: number;
  spotsLeft: number;
};

/**
 * One designed result panel. `callId` is what the announcement guard keys on: the polite region
 * must speak a correction EXACTLY once, and the subscription re-render that follows an optimistic
 * settle must not repeat it.
 */
type Outcome = {
  callId: number;
  tone: "good" | "warn" | "plain";
  headline: string;
  body: string | null;
  announcement: string;
  alternative: Alternative | null;
};

export default function ShiftSheet(props: {
  shiftId: string;
  deviceKey: string;
  now: number;
  announce: (msg: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { shiftId, deviceKey, now, announce, onClose } = props;

  const trapRef = useFocusTrap(true);
  useEscape(onClose, true);

  // The id arrives as an opaque string from the hash. A hand-edited link must paint an empty
  // sheet, not throw an argument-validation error out of a live subscription.
  const looksLikeId = shiftId.length === ID_LENGTH;
  const typedShiftId = shiftId as Id<"shifts">;
  const detail = useQuery(
    api.shifts.detail,
    looksLikeId ? { shiftId: typedShiftId, deviceKey } : "skip",
  );

  /* ------------------------------------------------------------ mutations -- */

  /**
   * OPTIMISTIC CLAIM. The spot fills in the same frame as the click, in both the board snapshot
   * behind the sheet and the roster inside it. When the server disagrees (waitlisted, conflict,
   * already, reseated) this patch is simply discarded on settle and the designed copy below
   * explains what really happened.
   */
  const claim = useMutation(api.shifts.claim).withOptimisticUpdate((localStore, args) => {
    const stamp = Date.now();

    const snap = localStore.getQuery(api.board.snapshot, {});
    if (snap) {
      let consumed = false;
      const shifts = snap.shifts.map((s) => {
        if (s._id !== args.shiftId || s.filledCount >= s.capacity || s.status !== "open") return s;
        consumed = true;
        return {
          ...s,
          filledCount: s.filledCount + 1,
          lastChangeAt: stamp,
          lastChangeKind: "claimed" as const,
          lastChangeActorName: "You",
          lastChangeIsSim: false,
        };
      });
      localStore.setQuery(
        api.board.snapshot,
        {},
        {
          ...snap,
          shifts,
          stats: consumed
            ? { ...snap.stats, spotsLeftTotal: Math.max(0, snap.stats.spotsLeftTotal - 1) }
            : snap.stats,
        },
      );
    }

    const detailArgs = { shiftId: args.shiftId, deviceKey: args.deviceKey };
    const local = localStore.getQuery(api.shifts.detail, detailArgs);
    if (!local || !local.shift || local.yourClaim || local.openPositions.length === 0) return;

    // Mirror the server's allocator exactly: the preferred spot when it is genuinely free,
    // otherwise the lowest free one.
    const preferred = args.preferredPosition;
    const position =
      preferred !== undefined && local.openPositions.includes(preferred)
        ? preferred
        : local.openPositions[0];

    const me = localStore.getQuery(api.board.myCommitments, { deviceKey: args.deviceKey });
    localStore.setQuery(api.shifts.detail, detailArgs, {
      ...local,
      shift: { ...local.shift, filledCount: local.shift.filledCount + 1 },
      roster: [
        ...local.roster,
        {
          position,
          handle: me?.volunteer?.handle ?? "You",
          glyph: me?.volunteer?.glyph ?? "YO",
          colorIndex: me?.volunteer?.colorIndex ?? 0,
          isYou: true,
          isSeed: false,
        },
      ].sort((a, b) => a.position - b.position),
      openPositions: local.openPositions.filter((p) => p !== position),
      yourClaim: {
        claimId: OPTIMISTIC_CLAIM_ID,
        kind: "spot" as const,
        position,
        waitlistRank: null,
      },
    });
  });

  /** The mirror of the claim patch, so giving a spot back is just as immediate. */
  const release = useMutation(api.shifts.release).withOptimisticUpdate((localStore, args) => {
    const stamp = Date.now();
    const detailArgs = { shiftId: args.shiftId, deviceKey: args.deviceKey };
    const local = localStore.getQuery(api.shifts.detail, detailArgs);
    const mine = local?.yourClaim ?? null;
    if (!local || !local.shift || !mine) return;

    if (mine.kind === "spot") {
      const snap = localStore.getQuery(api.board.snapshot, {});
      if (snap) {
        localStore.setQuery(
          api.board.snapshot,
          {},
          {
            ...snap,
            shifts: snap.shifts.map((s) =>
              s._id === args.shiftId && s.filledCount > 0
                ? {
                    ...s,
                    filledCount: s.filledCount - 1,
                    lastChangeAt: stamp,
                    lastChangeKind: "released" as const,
                    lastChangeActorName: "You",
                    lastChangeIsSim: false,
                  }
                : s,
            ),
            stats: { ...snap.stats, spotsLeftTotal: snap.stats.spotsLeftTotal + 1 },
          },
        );
      }
      localStore.setQuery(api.shifts.detail, detailArgs, {
        ...local,
        shift: { ...local.shift, filledCount: Math.max(0, local.shift.filledCount - 1) },
        roster: local.roster.filter((r) => !r.isYou),
        openPositions: [...local.openPositions, mine.position].sort((a, b) => a - b),
        yourClaim: null,
      });
      return;
    }

    localStore.setQuery(api.shifts.detail, detailArgs, {
      ...local,
      shift: { ...local.shift, waitlistCount: Math.max(0, local.shift.waitlistCount - 1) },
      waitlist: local.waitlist.filter((w) => !w.isYou),
      yourClaim: null,
    });
  });

  const addCapacity = useMutation(api.shifts.addCapacity);

  /* -------------------------------------------------------------- state -- */

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [activeSpot, setActiveSpot] = useState(0);

  const callSeq = useRef(0);
  const announcedRef = useRef(-1);
  const spotRefs = useRef(new Map<number, HTMLButtonElement | null>());
  const gridFocusedRef = useRef(false);
  const takenSnapshotRef = useRef<Map<number, string> | null>(null);
  const stolenAnnouncedRef = useRef("");

  /**
   * Announce a result EXACTLY ONCE. The panel itself keeps rendering across every subsequent
   * subscription re-render; this guard is what stops the polite region repeating the correction.
   */
  useEffect(() => {
    if (!outcome) return;
    if (announcedRef.current === outcome.callId) return;
    announcedRef.current = outcome.callId;
    announce(outcome.announcement);
  }, [outcome, announce]);

  /* ------------------------------------------------------------- derived -- */

  const shift = detail?.shift ?? null;
  const project = detail?.project ?? null;
  const roster = useMemo(() => detail?.roster ?? [], [detail]);
  const openPositions = detail?.openPositions ?? [];
  const waitlist = detail?.waitlist ?? [];
  const yourClaim = detail?.yourClaim ?? null;
  const history = detail?.activity ?? [];

  const capacity = shift?.capacity ?? 0;
  const filled = shift?.filledCount ?? 0;
  const spotsLeft = Math.max(0, capacity - filled);
  const waitingCount = shift?.waitlistCount ?? waitlist.length;
  const isFull = shift !== null && spotsLeft === 0;
  const isCancelled = shift?.status === "cancelled";

  const takenBy = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of roster) map.set(row.position, row.isYou ? "you" : row.handle);
    return map;
  }, [roster]);

  const meterText = `${filled} of ${capacity} ${plural(capacity, "spot", "spots")} filled, ${spotsLeft} left`;
  const whenText = shift ? absoluteWindow(shift.startsAt, shift.endsAt) : "";

  /**
   * FOCUS UNDER REMOTE CHANGE. If the spot you are standing on is taken by someone else, focus
   * must NOT move — the button is keyed by position and never unmounts, so the browser keeps it.
   * Only its accessible name changes, and the polite region says who took it.
   */
  useEffect(() => {
    const previous = takenSnapshotRef.current;
    takenSnapshotRef.current = takenBy;
    if (!previous || !gridFocusedRef.current) return;
    const holder = takenBy.get(activeSpot);
    if (!holder || holder === "you" || previous.get(activeSpot)) return;
    const key = `${activeSpot}:${holder}`;
    if (stolenAnnouncedRef.current === key) return;
    stolenAnnouncedRef.current = key;
    announce(`Spot ${activeSpot + 1} was just taken by ${holder}.`);
  }, [takenBy, activeSpot, announce]);

  /* ------------------------------------------------------------ handlers -- */

  const runClaim = useCallback(
    async (target: Id<"shifts">, preferredPosition?: number, targetLabel?: string) => {
      const callId = ++callSeq.current;
      setBusy(true);
      setProblem(null);
      try {
        const result = await claim({
          deviceKey,
          shiftId: target,
          ...(preferredPosition === undefined ? {} : { preferredPosition }),
        });
        const where = targetLabel ?? shift?.title ?? "this shift";
        const when = targetLabel ? "" : whenText;

        if (result.outcome === "claimed") {
          const spotNumber = result.position + 1;
          setOutcome({
            callId,
            tone: "good",
            headline: `You're in — spot ${spotNumber} of ${capacity || spotNumber}`,
            body: `${where}${when ? `, ${when}` : ""}. ${result.spotsLeft} ${plural(result.spotsLeft, "spot", "spots")} left after you.`,
            announcement: `Spot ${spotNumber} claimed. You're confirmed for ${where}${when ? `, ${when}` : ""}.`,
            alternative: null,
          });
        } else if (result.outcome === "reseated") {
          const asked = (result.requestedPosition ?? 0) + 1;
          const got = result.position + 1;
          setOutcome({
            callId,
            tone: "good",
            headline: `Spot ${asked} went to someone else — we put you in spot ${got}`,
            body: `A neighbour took spot ${asked} a moment before your click landed, so the server seated you in the lowest free spot instead of failing. You are confirmed for ${where}${when ? `, ${when}` : ""}.`,
            announcement: `Spot ${asked} was just taken. We put you in spot ${got}.`,
            alternative: null,
          });
        } else if (result.outcome === "already") {
          setOutcome({
            callId,
            tone: "plain",
            headline:
              result.kind === "spot"
                ? `You already have spot ${result.position + 1} here`
                : "You are already on the waitlist here",
            body:
              result.kind === "spot"
                ? "Nothing changed — one claim per neighbour per shift. Release it below if you want to give it up."
                : "Nothing changed. Your place in the queue is unchanged and shown below.",
            announcement:
              result.kind === "spot"
                ? `You already have spot ${result.position + 1} at ${where}.`
                : `You are already on the waitlist for ${where}.`,
            alternative: null,
          });
        } else if (result.outcome === "conflict") {
          setOutcome({
            callId,
            tone: "warn",
            headline: `That overlaps ${result.conflictTitle}`,
            body: `You are already committed to ${result.conflictTitle}, which starts ${absolutePoint(result.conflictStartsAt)}. Release that spot first if you would rather be here.`,
            announcement: `That overlaps ${result.conflictTitle}, starting ${absolutePoint(result.conflictStartsAt)}. Nothing was claimed.`,
            alternative: null,
          });
        } else if (result.outcome === "waitlisted") {
          setOutcome({
            callId,
            tone: "warn",
            headline: `Last spot went to ${result.lastActorName} · you're #${result.rank} on the waitlist`,
            body: "If anyone releases, the front of the queue moves into the exact spot they vacate — no refresh, no re-claim.",
            announcement: `Last spot went to ${result.lastActorName}. You're number ${result.rank} on the waitlist for ${where}.`,
            alternative: result.alternative,
          });
        }
      } catch (err) {
        setProblem(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [claim, deviceKey, shift, whenText, capacity],
  );

  const onPrimary = useCallback(() => {
    if (!shift) return;
    if (isCancelled) {
      announce("That shift was cancelled, so there is nothing to claim.");
      return;
    }
    // Deliberately still calls claim when you already hold something: the mutation is idempotent
    // and returns the "already" outcome, which renders as calm designed copy rather than an error.
    void runClaim(shift._id);
  }, [shift, isCancelled, runClaim, announce]);

  const onRelease = useCallback(async () => {
    if (!shift) return;
    if (!yourClaim) {
      announce(
        "You don't have a spot or a waitlist place here yet, so there is nothing to release.",
      );
      return;
    }
    const callId = ++callSeq.current;
    setBusy(true);
    setProblem(null);
    try {
      const result = await release({ deviceKey, shiftId: shift._id });
      if (result.outcome === "left_waitlist") {
        setOutcome({
          callId,
          tone: "plain",
          headline: "You left the waitlist",
          body: `Everyone behind you at ${shift.title} moved up one place.`,
          announcement: `You left the waitlist for ${shift.title}.`,
          alternative: null,
        });
      } else if (result.promoted) {
        setOutcome({
          callId,
          tone: "good",
          headline: `Released — ${result.promoted.handle} moved into your spot`,
          body: "The front of the waitlist took the exact position you vacated, in the same transaction. Every other open window already shows it.",
          announcement: `You released your spot at ${shift.title}. ${result.promoted.handle} moved off the waitlist into it.`,
          alternative: null,
        });
      } else {
        setOutcome({
          callId,
          tone: "plain",
          headline: "Released — the spot is open again",
          body: `Nobody was waiting, so ${shift.title} now has ${spotsLeft + 1} ${plural(spotsLeft + 1, "spot", "spots")} open.`,
          announcement: `You released your spot at ${shift.title}. It is open again.`,
          alternative: null,
        });
      }
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [shift, yourClaim, release, deviceKey, spotsLeft, announce]);

  const onAddCapacity = useCallback(async () => {
    if (!shift) return;
    if (shift.capacity + CAPACITY_DELTA > MAX_CAPACITY) {
      announce(
        `A shift can hold at most ${MAX_CAPACITY} people, so no more spots can be added here.`,
      );
      return;
    }
    const callId = ++callSeq.current;
    setBusy(true);
    setProblem(null);
    try {
      const result = await addCapacity({ deviceKey, shiftId: shift._id, delta: CAPACITY_DELTA });
      const promoted = result.promotedHandles;
      setOutcome({
        callId,
        tone: "good",
        headline:
          promoted.length > 0
            ? `${CAPACITY_DELTA} spots opened — ${promoted.length} ${plural(promoted.length, "neighbour", "neighbours")} promoted`
            : `${CAPACITY_DELTA} more spots opened`,
        body:
          promoted.length > 0
            ? `${listNames(promoted)} moved off the waitlist and into a spot in the same transaction. Capacity is now ${result.capacity}.`
            : `Nobody was waiting, so capacity is simply ${result.capacity} now.`,
        announcement:
          promoted.length > 0
            ? `${CAPACITY_DELTA} spots added. ${promoted.length} ${plural(promoted.length, "neighbour was", "neighbours were")} promoted: ${listNames(promoted)}.`
            : `${CAPACITY_DELTA} spots added at ${shift.title}. Nobody was waiting, so nobody was promoted.`,
        alternative: null,
      });
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [shift, addCapacity, deviceKey, announce]);

  /**
   * RACE TEST. Two tabs on one laptop share localStorage, so without `?as=new` the second window
   * resolves the SAME deviceKey, becomes the same neighbour, and the headline contention demo
   * silently misfires — the second window would just toggle the first window's own claim.
   * `as=new` mints a fresh key into sessionStorage only, which is per-tab, so the two windows are
   * genuinely two different people racing for the same last spot.
   */
  const raceUrl = useMemo(() => {
    if (typeof window === "undefined") return "#/";
    const url = new URL(window.location.href);
    url.hash = `#/shift/${shiftId}?as=new`;
    return url.toString();
  }, [shiftId]);

  const onRaceTest = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      window.open(raceUrl, "crewcall-race", "width=1100,height=800,noopener");
    },
    [raceUrl],
  );

  /* ------------------------------------------------------------ spot grid -- */

  const openGrid = useCallback(() => {
    setGridOpen((wasOpen) => {
      if (!wasOpen) setActiveSpot(openPositions.length > 0 ? openPositions[0] : 0);
      return !wasOpen;
    });
  }, [openPositions]);

  const focusSpot = useCallback((position: number) => {
    setActiveSpot(position);
    spotRefs.current.get(position)?.focus();
  }, []);

  /** ONE tab stop: roving tabindex, arrows between spots, Enter/Space claims (native button). */
  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (capacity === 0) return;
      let next: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (activeSpot + 1) % capacity;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (activeSpot - 1 + capacity) % capacity;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = capacity - 1;
      }
      if (next === null) return;
      event.preventDefault();
      focusSpot(next);
    },
    [activeSpot, capacity, focusSpot],
  );

  const onSpotActivate = useCallback(
    (position: number) => {
      if (!shift) return;
      const holder = takenBy.get(position);
      if (holder) {
        announce(
          holder === "you"
            ? `Spot ${position + 1} is already yours.`
            : `Spot ${position + 1} is taken by ${holder}. Pick an available spot, or use Claim a spot and the server will seat you.`,
        );
        return;
      }
      void runClaim(shift._id, position);
    },
    [shift, takenBy, runClaim, announce],
  );

  /* -------------------------------------------------------------- render -- */

  if (!looksLikeId || (detail !== undefined && shift === null)) {
    return (
      <div className="backdrop">
        <div
          className="sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sheet-title"
          ref={trapRef}
        >
          <div className="sheet__head">
            <h2 id="sheet-title">That shift is no longer on the board</h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="empty">
            It may have been cancelled, or the link may be out of date. Close this and pick another
            shift from the board.
          </p>
        </div>
      </div>
    );
  }

  if (detail === undefined || !shift) {
    return (
      <div className="backdrop">
        <div
          className="sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sheet-title"
          ref={trapRef}
        >
          <div className="sheet__head">
            <h2 id="sheet-title">Opening this shift…</h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="empty">Loading the roster, the waitlist and this shift's history.</p>
        </div>
      </div>
    );
  }

  const primaryLabel = isFull ? "Join the waitlist" : "Claim a spot";
  const primaryName = isFull
    ? `Join the waitlist for ${shift.title}, ${whenText}, full with ${waitingCount} ${plural(waitingCount, "neighbour", "neighbours")} waiting`
    : `Claim a spot at ${shift.title}, ${whenText}, ${meterText}`;

  const primaryBlockedReason = isCancelled
    ? "This shift was cancelled, so nothing can be claimed."
    : yourClaim
      ? yourClaim.kind === "spot"
        ? `You already hold spot ${yourClaim.position + 1} here. Release it below if you want to give it up.`
        : `You are already #${yourClaim.waitlistRank ?? 1} on the waitlist here.`
      : null;

  const capacityBlocked = shift.capacity + CAPACITY_DELTA > MAX_CAPACITY;

  return (
    <div className="backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        ref={trapRef}
        style={accentVars(project?.accentIndex ?? 0)}
      >
        <div className="sheet__head">
          <div className="stack">
            <h2 id="sheet-title" className="shift__title">
              {shift.title}
            </h2>
            <p className="shift__project">
              {project?.title ?? "A neighbourhood project"}
              {project ? ` · ${project.orgName}` : ""}
            </p>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>

        {problem ? (
          <p className="notice notice--warn" role="alert">
            {problem}
          </p>
        ) : null}

        {/* ------------------------------------------------------- the facts -- */}
        <section className="stack" aria-labelledby="sheet-what">
          <h3 id="sheet-what">What this is</h3>
          <p className="shift__meta">
            <span>{shift.role}</span>
            <span>
              <time dateTime={isoAttr(shift.startsAt)}>
                {relativeStart(shift.startsAt, shift.endsAt, now)} · {whenText}
              </time>
            </span>
            <span>Meet at {shift.meetPoint}</span>
            {project ? <span>{project.locationLabel}</span> : null}
          </p>
          <p className="muted">
            {shift.bring.length > 0
              ? `Bring: ${shift.bring.join(", ")}`
              : "Nothing to bring — everything is provided on site."}
          </p>
          {isCancelled ? (
            <p className="notice notice--warn">This shift was cancelled by the organiser.</p>
          ) : null}
        </section>

        {/* -------------------------------------------------------- capacity -- */}
        <section className="stack" aria-labelledby="sheet-capacity">
          <h3 id="sheet-capacity">Capacity</h3>
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={filled}
            aria-valuemin={0}
            aria-valuemax={capacity}
            aria-valuetext={meterText}
            aria-label={`Spots filled at ${shift.title}`}
          >
            <span
              className="meter__fill"
              style={{ width: `${capacity === 0 ? 0 : Math.round((filled / capacity) * 100)}%` }}
            />
          </div>
          <div className="pips" aria-hidden="true">
            {Array.from({ length: capacity }, (_, i) => (
              <span key={i} className={takenBy.has(i) ? "pip pip--filled" : "pip"} />
            ))}
          </div>
          <p className="row">
            <span className={spotsLeft > 0 && spotsLeft <= 2 ? "badge badge--urgent" : "badge"}>
              {isFull ? `Full · ${waitingCount} waiting` : `${spotsLeft} left`}
            </span>
            <span className="badge">{relativeStart(shift.startsAt, shift.endsAt, now)}</span>
            {yourClaim ? (
              <span className="badge badge--you">
                {yourClaim.kind === "spot"
                  ? `You're in · spot ${yourClaim.position + 1}`
                  : `Waitlist #${yourClaim.waitlistRank ?? 1}`}
              </span>
            ) : null}
          </p>
        </section>

        {/* ------------------------------------------------------ the result -- */}
        {outcome ? (
          <section
            className={
              outcome.tone === "good"
                ? "notice notice--good"
                : outcome.tone === "warn"
                  ? "notice notice--warn"
                  : "notice"
            }
            aria-labelledby="sheet-outcome"
          >
            <h3 id="sheet-outcome">{outcome.headline}</h3>
            {outcome.body ? <p>{outcome.body}</p> : null}
            {outcome.alternative ? (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  const alt = outcome.alternative;
                  if (!alt) return;
                  void runClaim(alt.shiftId, undefined, alt.title);
                }}
                aria-label={`Take ${outcome.alternative.title} instead, ${absolutePoint(outcome.alternative.startsAt)}, ${outcome.alternative.spotsLeft} ${plural(outcome.alternative.spotsLeft, "spot", "spots")} left`}
              >
                Take {outcome.alternative.title} instead ({outcome.alternative.spotsLeft}{" "}
                {plural(outcome.alternative.spotsLeft, "spot", "spots")})
              </button>
            ) : null}
          </section>
        ) : null}

        {/* --------------------------------------------------------- actions -- */}
        <section className="stack" aria-labelledby="sheet-actions">
          <h3 id="sheet-actions">Your move</h3>

          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              onClick={onPrimary}
              aria-disabled={primaryBlockedReason !== null || busy}
              aria-label={primaryName}
            >
              {primaryLabel}
            </button>

            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void onRelease()}
              aria-disabled={yourClaim === null || busy}
              aria-label={
                yourClaim && yourClaim.kind === "waitlist"
                  ? `Leave the waitlist for ${shift.title}, ${whenText}`
                  : `Release your spot at ${shift.title}, ${whenText}`
              }
            >
              {yourClaim && yourClaim.kind === "waitlist" ? "Leave the waitlist" : "Release"}
            </button>

            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void onAddCapacity()}
              aria-disabled={capacityBlocked || busy}
              aria-label={`Open ${CAPACITY_DELTA} more spots at ${shift.title}, promoting up to ${CAPACITY_DELTA} waiting neighbours`}
            >
              +{CAPACITY_DELTA} spots
            </button>
          </div>

          {/* Adjacent explanatory text for the aria-disabled controls above: they stay focusable
              and explain themselves rather than becoming holes in the tab order. */}
          {primaryBlockedReason ? <p className="muted">{primaryBlockedReason}</p> : null}
          {yourClaim === null ? (
            <p className="muted">
              Release does nothing until you hold a spot or a waitlist place on this shift.
            </p>
          ) : null}
          {capacityBlocked ? (
            <p className="muted">
              This shift is already at the {MAX_CAPACITY}-person ceiling, so no more spots can be
              added.
            </p>
          ) : null}
          <p className="muted">
            +{CAPACITY_DELTA} spots grows capacity and promotes the front of the waitlist in the
            same transaction — the fastest way to watch a promotion land in two windows at once.
          </p>

          <p>
            <a
              href={raceUrl}
              className="btn btn--ghost btn--sm"
              onClick={onRaceTest}
              rel="noreferrer"
            >
              Race test — open as another neighbour
            </a>
          </p>
          <p className="muted">
            Opens this same shift in a second window with its own identity, so you can race
            yourself for the last spot.
          </p>
        </section>

        {/* ------------------------------------------- optional specific spot -- */}
        <section className="stack" aria-labelledby="sheet-grid-heading">
          <h3 id="sheet-grid-heading">Choosing a spot</h3>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-expanded={gridOpen}
            aria-controls="spot-grid"
            onClick={openGrid}
          >
            Pick a specific spot (optional)
          </button>
          <p className="muted">
            You never need this — Claim a spot seats you in the lowest free position.
          </p>

          {gridOpen ? (
            <>
              <div
                id="spot-grid"
                className="spot-grid"
                role="group"
                aria-label={`Specific spots at ${shift.title}. Arrow keys move between spots, Enter claims one.`}
                onKeyDown={onGridKeyDown}
                onFocus={() => {
                  gridFocusedRef.current = true;
                }}
                onBlur={() => {
                  gridFocusedRef.current = false;
                }}
              >
                {Array.from({ length: capacity }, (_, position) => {
                  const holder = takenBy.get(position);
                  const name =
                    holder === undefined
                      ? `Spot ${position + 1} of ${capacity}, available`
                      : holder === "you"
                        ? `Spot ${position + 1}, yours`
                        : `Spot ${position + 1}, taken by ${holder}`;
                  return (
                    <button
                      key={position}
                      type="button"
                      className="btn btn--sm"
                      ref={(node) => {
                        spotRefs.current.set(position, node);
                      }}
                      tabIndex={position === activeSpot ? 0 : -1}
                      aria-disabled={holder !== undefined}
                      aria-label={name}
                      onFocus={() => setActiveSpot(position)}
                      onClick={() => onSpotActivate(position)}
                    >
                      <span aria-hidden="true" className="tnum">
                        {position + 1}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="muted">
                Taken spots stay focusable on purpose — they announce who holds them instead of
                vanishing from the tab order. {openPositions.length}{" "}
                {plural(openPositions.length, "spot is", "spots are")} free right now.
              </p>
            </>
          ) : null}
        </section>

        {/* ---------------------------------------------------------- roster -- */}
        <section className="stack" aria-labelledby="sheet-roster">
          <h3 id="sheet-roster">Who's coming</h3>
          {capacity === 0 ? (
            <p className="empty">This shift has no spots configured.</p>
          ) : (
            <ul className="roster">
              {Array.from({ length: capacity }, (_, position) => {
                const person = roster.find((r) => r.position === position);
                return (
                  <li
                    key={position}
                    className={person ? "roster__row" : "roster__row roster__row--open"}
                  >
                    {person ? (
                      <>
                        <span
                          className="glyph"
                          aria-hidden="true"
                          style={glyphVars(person.colorIndex)}
                        >
                          {person.glyph}
                        </span>
                        <span>
                          Spot {position + 1} —{" "}
                          {person.isYou ? `${person.handle} (you)` : person.handle}
                        </span>
                        {person.isSeed ? <span className="badge badge--sim">sim</span> : null}
                      </>
                    ) : (
                      <span>Spot {position + 1} — open</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* -------------------------------------------------------- waitlist -- */}
        <section className="stack" aria-labelledby="sheet-waitlist">
          <h3 id="sheet-waitlist">Waitlist</h3>
          {waitlist.length === 0 ? (
            <p className="empty">Nobody is waiting. If this fills, the queue starts here.</p>
          ) : (
            <ol className="roster">
              {waitlist.map((person) => (
                <li key={person.claimId} className="roster__row">
                  <span className="glyph" aria-hidden="true" style={glyphVars(person.colorIndex)}>
                    {person.glyph}
                  </span>
                  <span>
                    #{person.rank} — {person.isYou ? `${person.handle} (you)` : person.handle}
                  </span>
                  {person.isYou ? <span className="badge badge--you">That's you</span> : null}
                  {person.isSeed ? <span className="badge badge--sim">sim</span> : null}
                </li>
              ))}
            </ol>
          )}
          {yourClaim && yourClaim.kind === "waitlist" ? (
            <p className="muted">
              You are #{yourClaim.waitlistRank ?? 1} in line. If anyone releases, the front of the
              queue moves into the exact spot they vacate.
            </p>
          ) : null}
        </section>

        {/* --------------------------------------------------------- history -- */}
        <section className="stack" aria-labelledby="sheet-history">
          <h3 id="sheet-history">What happened here</h3>
          {history.length === 0 ? (
            <p className="empty">No changes recorded on this shift yet.</p>
          ) : (
            <ul className="live">
              {history.map((row) => (
                <li key={row._id} className="live__row">
                  <span>{row.message}</span>
                  <span className="live__when">
                    <time dateTime={isoAttr(row.createdAt)}>
                      {relativePast(row.createdAt, now)} · {absolutePoint(row.createdAt)}
                    </time>
                  </span>
                  {row.isSim ? <span className="badge badge--sim">sim</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
