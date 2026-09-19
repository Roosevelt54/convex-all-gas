import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------------ */
/* Time formatting                                                          */
/*                                                                          */
/* The server returns RAW timestamps only, because a Convex query does not   */
/* re-run just because wall-clock time passed. Every "in 4h" / "8s ago"      */
/* string is therefore computed here and re-rendered from a ticking clock.   */
/* ------------------------------------------------------------------------ */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "just now" / "8s ago" / "11m ago" / "3h ago" / "2d ago" */
export function relativePast(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 5_000) return "just now";
  if (d < MIN) return `${Math.floor(d / 1000)}s ago`;
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  return `${Math.floor(d / DAY)}d ago`;
}

/** "Starts in 4h" / "Starts in 25m" / "In progress" / "Tomorrow" / "In 3 days" */
export function relativeStart(startsAt: number, endsAt: number, now: number): string {
  if (now >= startsAt && now < endsAt) return "In progress";
  if (now >= endsAt) return "Finished";
  const d = startsAt - now;
  if (d < MIN) return "Starts in under a minute";
  if (d < HOUR) return `Starts in ${Math.floor(d / MIN)}m`;
  if (d < 24 * HOUR) return `Starts in ${Math.floor(d / HOUR)}h`;
  const days = Math.round(d / DAY);
  return days <= 1 ? "Tomorrow" : `In ${days} days`;
}

/** Absolute, human, and locale-aware: "Sat Sep 13 9:00 AM – 12:00 PM". */
export function absoluteWindow(startsAt: number, endsAt: number): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const day = s.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} ${t(s)} – ${t(e)}`;
}

/** Machine-readable value for <time datetime="...">. */
export function isoAttr(ts: number): string {
  return new Date(ts).toISOString();
}

/* ------------------------------------------------------------------------ */
/* Hooks                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * A shared ticking clock. Relative times must keep moving even when no data changes,
 * so every component rendering "8s ago" re-renders off this.
 */
export function useClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    // Snap immediately when the tab is refocused rather than waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return now;
}

export type Route =
  | { name: "board" }
  | { name: "shift"; shiftId: string }
  | { name: "wall" }
  | { name: "organize" }
  | { name: "home" }
  | { name: "join"; code: string }
  | { name: "community"; communityId: string };

export function parseHash(hash: string): Route {
  const q = hash.indexOf("?");
  const path = (q === -1 ? hash : hash.slice(0, q)).replace(/^#/, "");
  // No route (or an in-page anchor like "#how") is the landing page; "#/" is the live board.
  if (!path.startsWith("/")) return { name: "home" };
  if (path === "/wall") return { name: "wall" };
  if (path === "/organize") return { name: "organize" };
  const j = path.match(/^\/join\/([^/]+)$/);
  if (j) return { name: "join", code: decodeURIComponent(j[1]) };
  const c = path.match(/^\/c\/([^/]+)$/);
  if (c) return { name: "community", communityId: decodeURIComponent(c[1]) };
  const m = path.match(/^\/shift\/([^/]+)$/);
  if (m) return { name: "shift", shiftId: decodeURIComponent(m[1]) };
  return { name: "board" };
}

/**
 * The "?as=new" suffix when the current page is the race-test window, else "". Preserving it
 * across in-app navigation matters: without it the race-test window silently reverts to being
 * the same neighbour as the first window.
 */
function identitySuffix(): string {
  const current = window.location.hash;
  const q = current.indexOf("?");
  return q !== -1 && current.slice(q).includes("as=new") ? "?as=new" : "";
}

/** An href for an in-app route ("/organize" → "#/organize"), keeping ?as=new when present. */
export function routeHref(to: string): string {
  return `#${to}${identitySuffix()}`;
}

/** Hash routing so deep links never need an SPA 404 fallback on convex.site. */
export function useHashRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((to: string) => {
    window.location.hash = `${to}${identitySuffix()}`;
  }, []);
  return [route, navigate];
}

/**
 * A polite live region driver.
 *
 * Deliberately NOT wired to every counter change: a naive aria-live on a fast-updating
 * number is a screen-reader failure, not a feature. Only deliberate, user-meaningful
 * events are announced, and each is announced exactly once.
 */
export function useAnnouncer(): [string, (msg: string) => void] {
  const [message, setMessage] = useState("");
  const lastRef = useRef<string>("");
  const announce = useCallback((msg: string) => {
    if (msg === lastRef.current) {
      // Re-announce an identical string by nudging it; otherwise SRs may skip it.
      setMessage(`${msg}​`);
    } else {
      setMessage(msg);
    }
    lastRef.current = msg;
  }, []);
  return [message, announce];
}

/** Persisted boolean flag, safe in private mode. */
export function usePersistentFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* private mode: keep it in memory only */
      }
    },
    [key],
  );
  return [value, set];
}

/** Escape key handler for dialogs. */
export function useEscape(onEscape: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onEscape, active]);
}

/**
 * Focus trap that returns focus to whatever opened the dialog. Keyboard users must never
 * be able to tab out of a modal into an inert background.
 */
export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (!node) return;

    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(selector));

    const first = focusables()[0];
    (first ?? node).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    const restore = restoreRef.current;
    return () => {
      node.removeEventListener("keydown", onKey);
      restore?.focus?.();
    };
  }, [active]);

  return ref;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
