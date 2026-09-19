import { useEffect, useState } from "react";
import type { JSX } from "react";
import "./Person.css";

/** "2d 4h" / "3h 05m" / "12m 04s" / "45s". Never negative. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** Coarse wording for screen readers, so they are not fed a new number every second. */
function spokenRemaining(ms: number): string {
  const min = Math.ceil(Math.max(0, ms) / 60_000);
  if (min <= 1) return "less than a minute";
  if (min < 60) return `about ${min} minutes`;
  const h = Math.round(min / 60);
  if (h < 48) return `about ${h} ${h === 1 ? "hour" : "hours"}`;
  return `about ${Math.round(h / 24)} days`;
}

/**
 * A live countdown that re-renders only itself — never the whole board — once a second while
 * under an hour away, and every 30 seconds otherwise.
 *
 * The ticking digits are aria-hidden; screen readers get a coarse "about 12 minutes" that only
 * changes once a minute. Reaching zero does NOT unlock anything: the server's scheduled function
 * flips the shift open and every subscriber updates from that write. `onDone` is only a hint
 * for the UI to show "Opening…" while that write arrives.
 */
export default function Countdown({
  to,
  label = "Opens in",
  onDone,
}: {
  to: number;
  label?: string;
  onDone?: () => void;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const remaining = to - now;
  const done = remaining <= 0;
  const fast = remaining < 3_600_000;

  useEffect(() => {
    if (done) return;
    const id = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [fast, done]);

  useEffect(() => {
    if (done) onDone?.();
    // Fire once on the transition to zero, not on every onDone identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (done) {
    return <span className="countdown countdown--done">Opening…</span>;
  }
  return (
    <span className="countdown">
      <span aria-hidden="true">
        {label} <span className="countdown__digits">{formatRemaining(remaining)}</span>
      </span>
      <span className="sr-only">
        {label} {spokenRemaining(remaining)}
      </span>
    </span>
  );
}
