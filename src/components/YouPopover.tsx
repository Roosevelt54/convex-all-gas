import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
} from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { absoluteWindow, isoAttr, relativeStart, useEscape, useFocusTrap } from "../util";
import { PersonName } from "./Person";

/** Six accent tokens exist in styles.css; colorIndex is hash % 8, so fold it. */
const ACCENT_COUNT = 6;

function accentVars(colorIndex: number): CSSProperties {
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

/* ---------------------------------------------------------------- .ics -- */

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** RFC 5545 UTC form: 20260912T090000Z. */
function icsStamp(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

type CalendarEvent = {
  uid: string;
  startsAt: number;
  endsAt: number;
  summary: string;
  location: string;
  description: string;
};

function buildIcs(events: CalendarEvent[]): string {
  const stamp = icsStamp(Date.now());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crewcall//Neighborhood shift board//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}@crewcall`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(event.startsAt)}`,
      `DTEND:${icsStamp(event.endsAt)}`,
      `SUMMARY:${icsText(event.summary)}`,
      `LOCATION:${icsText(event.location)}`,
      `DESCRIPTION:${icsText(event.description)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/* --------------------------------------------------------------- view -- */

export default function YouPopover(props: {
  deviceKey: string;
  now: number;
  volunteer: { handle: string; glyph: string; colorIndex: number } | null;
  announce: (msg: string) => void;
  onClose: () => void;
  onOpenAccount: () => void;
  onSignOut: () => Promise<void>;
}): JSX.Element {
  const { deviceKey, now, volunteer, announce, onClose, onOpenAccount, onSignOut } = props;

  const trapRef = useFocusTrap(true);
  useEscape(onClose, true);

  const me = useQuery(api.volunteers.me, { deviceKey });
  const { isAuthenticated } = useConvexAuth();
  const [signingOut, setSigningOut] = useState(false);

  const signOutHere = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  }, [signingOut, onSignOut]);

  const mine = useQuery(api.board.myCommitments, { deviceKey });
  const rename = useMutation(api.volunteers.rename);
  const release = useMutation(api.shifts.release);

  const [problem, setProblem] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);

  /* ------------------------------------------------------ handle edit -- */
  const liveHandle = me?.handle ?? mine?.volunteer?.handle ?? volunteer?.handle ?? "";
  const [draft, setDraft] = useState(liveHandle);
  const knownHandleRef = useRef(liveHandle);

  useEffect(() => {
    // Adopt the server's handle when it changes underneath us (first paint, or our own
    // rename landing) without stomping on what is being typed right now.
    if (liveHandle === knownHandleRef.current) return;
    knownHandleRef.current = liveHandle;
    setDraft(liveHandle);
  }, [liveHandle]);

  const commitHandle = useCallback(async () => {
    const next = draft.trim();
    if (next.length === 0 || next === knownHandleRef.current) {
      setDraft(knownHandleRef.current);
      return;
    }
    try {
      const result = await rename({ deviceKey, handle: next });
      knownHandleRef.current = result.handle;
      setDraft(result.handle);
      setProblem(null);
      announce(`Your name is now ${result.handle}. Rosters and future activity show it.`);
    } catch (err) {
      setProblem(errorMessage(err));
      setDraft(knownHandleRef.current);
    }
  }, [draft, rename, deviceKey, announce]);

  const onHandleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      // Blur commits, so Enter and clicking away take the exact same path.
      event.currentTarget.blur();
    }
  }, []);

  /* --------------------------------------------------------- releasing -- */
  const onRelease = useCallback(
    async (shiftId: Id<"shifts">, title: string) => {
      setReleasing(shiftId);
      try {
        const result = await release({ deviceKey, shiftId });
        setProblem(null);
        if (result.outcome === "left_waitlist") {
          announce(`You left the waitlist for ${title}.`);
        } else if (result.promoted) {
          announce(
            `You released your spot at ${title}. ${result.promoted.handle} moved off the waitlist into it.`,
          );
        } else {
          announce(`You released your spot at ${title}. It is open for a neighbour again.`);
        }
      } catch (err) {
        setProblem(errorMessage(err));
      } finally {
        setReleasing(null);
      }
    },
    [release, deviceKey, announce],
  );

  /* ---------------------------------------------------------- calendar -- */
  // Chronological order, and only confirmed spots become calendar events — a waitlist
  // place is not yet an appointment.
  const rows = mine ? [...mine.claims].sort((a, b) => a.startsAt - b.startsAt) : [];
  const spots = rows.filter((row) => row.kind === "spot");

  const downloadIcs = useCallback(() => {
    if (spots.length === 0) return;
    const ics = buildIcs(
      spots.map((row) => ({
        uid: row.claimId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        summary: `${row.shiftTitle} — ${row.projectTitle}`,
        location: row.meetPoint,
        description: `Crewcall volunteer shift. Spot ${row.position + 1} of ${row.capacity}. Meet at ${row.meetPoint}.`,
      })),
    );
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "crewcall-shifts.ics";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Revoke once the browser has had the tick it needs to start the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    announce(
      `Calendar file with ${spots.length} ${spots.length === 1 ? "shift" : "shifts"} downloaded.`,
    );
  }, [spots, announce]);

  const glyph = me?.glyph ?? mine?.volunteer?.glyph ?? volunteer?.glyph ?? "";
  const colorIndex = me?.colorIndex ?? mine?.volunteer?.colorIndex ?? volunteer?.colorIndex ?? 0;
  const verified = me?.verified ?? false;
  // Trust the server's view of the account once it has loaded; fall back to the client's.
  const signedIn = me ? me.verified : isAuthenticated;

  return (
    <div className="backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="you-title"
        ref={trapRef}
      >
        <div className="sheet__head">
          <div className="row">
            <span className="glyph" aria-hidden="true" style={accentVars(colorIndex)}>
              {glyph}
            </span>
            <h2 id="you-title">You on this board</h2>
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

        <section className="stack" aria-labelledby="you-account-heading">
          <h3 id="you-account-heading">Your account</h3>
          {me === undefined ? (
            <p className="muted">Checking who you are…</p>
          ) : signedIn ? (
            <>
              <p>
                Signed in as{" "}
                <PersonName handle={liveHandle} verified={verified} />
                {me?.username ? <span className="muted"> · username {me.username}</span> : null}
              </p>
              <p className="muted">
                The ✓ tells organizers it is really you. Your spots belong to your account, so they
                follow you to any device you sign in on.
              </p>
              <p className="row">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  aria-disabled={signingOut}
                  onClick={() => void signOutHere()}
                >
                  Sign out
                </button>
                {signingOut ? <span className="muted">Signing you out…</span> : null}
              </p>
            </>
          ) : (
            <>
              <p>
                You are browsing as{" "}
                <PersonName handle={liveHandle} verified={false} />
              </p>
              <p className="muted">
                Guests can claim, waitlist and use “Notify me”. An account adds a ✓ next to your
                name and lets you post shifts — just a username and password, no email.
              </p>
              <p className="row">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={onOpenAccount}
                >
                  Sign in or create an account
                </button>
              </p>
            </>
          )}
        </section>

        <section className="stack" aria-labelledby="you-name-heading">
          <h3 id="you-name-heading">Your display name</h3>
          <label htmlFor="you-handle">
            Neighbours see this name on rosters and in the activity feed
          </label>
          <input
            id="you-handle"
            type="text"
            value={draft}
            maxLength={24}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onHandleKeyDown}
            onBlur={() => void commitHandle()}
          />
          <p className="muted">Press Enter or move on to save. Up to 24 characters.</p>
        </section>

        <section className="stack" aria-labelledby="you-commitments-heading">
          <h3 id="you-commitments-heading">My commitments</h3>

          {mine === undefined ? (
            <p className="muted">Loading your commitments…</p>
          ) : rows.length === 0 ? (
            <p className="empty">
              Nothing claimed yet. Take a spot on the board and it shows up here.
            </p>
          ) : (
            <ul className="roster">
              {rows.map((row) => {
                const title = `${row.shiftTitle} at ${row.projectTitle}`;
                const when = absoluteWindow(row.startsAt, row.endsAt);
                const state =
                  row.kind === "spot"
                    ? `You're in · spot ${row.position + 1} of ${row.capacity}`
                    : `Waitlist #${row.waitlistRank ?? row.position + 1}`;
                const busy = releasing === row.shiftId;
                return (
                  <li className="roster__row" key={row.claimId}>
                    <article className="stack">
                      <h4>{title}</h4>
                      <p className="muted">
                        <time dateTime={isoAttr(row.startsAt)}>
                          {relativeStart(row.startsAt, row.endsAt, now)} · {when}
                        </time>
                      </p>
                      <p className="row">
                        <span className={row.kind === "spot" ? "badge badge--you" : "badge"}>
                          {state}
                        </span>
                        <span className="muted">Meet at {row.meetPoint}</span>
                      </p>
                      {row.overlapsWithClaimId ? (
                        <p className="notice notice--warn">
                          Heads up: this overlaps another shift you have claimed. Release one so a
                          neighbour can take it.
                        </p>
                      ) : null}
                      <p className="row">
                        <button
                          type="button"
                          className="btn btn--danger btn--sm"
                          aria-disabled={busy}
                          aria-label={
                            row.kind === "spot"
                              ? `Release your spot at ${title}, ${when}`
                              : `Leave the waitlist for ${title}, ${when}`
                          }
                          onClick={() => {
                            if (busy) return;
                            void onRelease(row.shiftId, row.shiftTitle);
                          }}
                        >
                          {row.kind === "spot" ? "Release" : "Leave waitlist"}
                        </button>
                        {busy ? <span className="muted">Saving your change…</span> : null}
                      </p>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="stack" aria-labelledby="you-calendar-heading">
          <h3 id="you-calendar-heading">Add to calendar</h3>
          <p className="row">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              aria-disabled={spots.length === 0}
              aria-label={
                spots.length === 0
                  ? "Add to calendar. Unavailable until you hold a confirmed spot."
                  : `Add to calendar: download a file with your ${spots.length} confirmed ${
                      spots.length === 1 ? "shift" : "shifts"
                    }`
              }
              onClick={downloadIcs}
            >
              Add to calendar (.ics)
            </button>
            {spots.length === 0 ? (
              <span className="muted">
                Available once you hold a confirmed spot — a waitlist place is not an appointment
                yet.
              </span>
            ) : (
              <span className="muted">
                {spots.length} confirmed {spots.length === 1 ? "shift" : "shifts"}, built in your
                browser — no email, no round trip.
              </span>
            )}
          </p>
        </section>

        <section className="stack" aria-labelledby="you-about-heading">
          <h3 id="you-about-heading">About this identity</h3>
          {signedIn ? (
            <p className="muted">
              You are signed in with a username and password. Organizers see a ✓ next to your
              name, which a guest cannot fake by typing the same name. Signing out turns this
              browser back into a fresh guest; your spots stay with your account.
            </p>
          ) : (
            <p className="muted">
              As a guest you are known to this board by a key stored in this browser only — no
              account, nothing sent anywhere else. It is a convenience, not proof of who you are: a
              new browser is a new neighbour, and anyone can type any name. That is why guest names
              show “(guest)” and account names show a ✓.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
