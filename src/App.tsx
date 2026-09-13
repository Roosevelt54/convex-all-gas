import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { resolveDeviceKey, wantsFreshIdentity } from "./identity";
import {
  prefersReducedMotion,
  useAnnouncer,
  useClock,
  useHashRoute,
  usePersistentFlag,
} from "./util";
import Board from "./components/Board";
import ShiftSheet from "./components/ShiftSheet";
import Wall from "./components/Wall";
import YouPopover from "./components/YouPopover";

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

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

type Theme = "light" | "dark";

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem("crewcall.theme");
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

export default function App(): JSX.Element {
  /* ----------------------------------------------------------- identity -- */
  // Resolved ONCE. Re-resolving on every render would mint a new neighbour under
  // the race-test window and quietly break the contention demo.
  const [deviceKey] = useState<string>(() => resolveDeviceKey());
  const [isRaceWindow] = useState<boolean>(() => wantsFreshIdentity());

  const ensure = useMutation(api.volunteers.ensure);
  const [ensured, setEnsured] = useState<{
    handle: string;
    glyph: string;
    colorIndex: number;
  } | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    // StrictMode double-invokes effects in development; the ref makes the upsert fire once.
    // Deliberately NO cleanup/"alive" guard: StrictMode's simulated unmount would flip that
    // guard on the only in-flight request, and the early return on remount means no second
    // request exists to take its place — identityReady would never become true and the
    // presence heartbeat would never start. setState after unmount is a no-op in React 18+.
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void ensure({ deviceKey })
      .then((volunteer) => {
        setEnsured({
          handle: volunteer.handle,
          glyph: volunteer.glyph,
          colorIndex: volunteer.colorIndex,
        });
      })
      .catch(() => {
        // A failed upsert must not blank the page; reads and presence still work.
      })
      .finally(() => {
        setIdentityReady(true);
      });
  }, [ensure, deviceKey]);

  /* ------------------------------------------------------------- shared -- */
  const now = useClock(30_000);
  const [announcement, announce] = useAnnouncer();
  const [route, navigate] = useHashRoute();

  // Live "you": myCommitments re-runs after a rename, so the chip follows the edit.
  const mine = useQuery(api.board.myCommitments, { deviceKey });
  const volunteer = mine?.volunteer ?? ensured;

  const snapshot = useQuery(api.board.snapshot, {});
  const demo = useQuery(api.meta.demoState, {});
  const presence = useQuery(api.presence.onScope, { scope: "board" });

  const setPulse = useMutation(api.meta.setPulse);
  const ping = useMutation(api.presence.ping);
  const leave = useMutation(api.presence.leave);

  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [youOpen, setYouOpen] = useState(false);
  const [proofDismissed, setProofDismissed] = usePersistentFlag("crewcall.proofDismissed", false);

  /* -------------------------------------------------------------- theme -- */
  const [theme, setTheme] = useState<Theme | null>(() => readStoredTheme());
  // Dark is the product default regardless of OS preference; light is an explicit opt-in.
  const effectiveTheme: Theme = theme ?? "dark";

  useEffect(() => {
    if (!theme) return;
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next: Theme = effectiveTheme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("crewcall.theme", next);
    } catch {
      // Private mode: the attribute still applies for this page's lifetime.
    }
  }, [effectiveTheme]);

  /* ----------------------------------------------------------- presence -- */
  const scope = route.name === "wall" ? "wall" : "board";

  useEffect(() => {
    // ping returns silently when the volunteer row is not there yet, so wait for the
    // upsert to settle rather than burning the first heartbeat.
    if (!identityReady) return;

    const beat = () => {
      void ping({ deviceKey, scope }).catch(() => {});
    };
    const depart = () => {
      void leave({ deviceKey, scope }).catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") depart();
      else beat();
    };

    beat();
    const id = window.setInterval(beat, 15_000);
    window.addEventListener("pagehide", depart);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("pagehide", depart);
      document.removeEventListener("visibilitychange", onVisibility);
      // Leaving this scope (route change, unmount) drops the presence row immediately
      // instead of waiting out the 45s sweep.
      depart();
    };
  }, [identityReady, deviceKey, scope, ping, leave]);

  /* ------------------------------------------- threshold-only announcer -- */
  // Header counters are NOT a live region. This separate polite region, debounced 3s,
  // announces threshold crossings only.
  const criticalCount = snapshot?.stats.criticalCount;
  const [thresholdMessage, setThresholdMessage] = useState("");
  const lastCriticalRef = useRef<number | null>(null);

  useEffect(() => {
    if (criticalCount === undefined) return;
    const id = window.setTimeout(() => {
      if (lastCriticalRef.current === null) {
        lastCriticalRef.current = criticalCount;
        return;
      }
      if (lastCriticalRef.current === criticalCount) return;
      lastCriticalRef.current = criticalCount;
      setThresholdMessage(
        `${criticalCount} ${plural(criticalCount, "shift is", "shifts are")} now critical.`,
      );
    }, 3_000);
    return () => window.clearTimeout(id);
  }, [criticalCount]);

  /* ------------------------------------------------------------ actions -- */
  const openWall = useCallback(() => {
    const url = new URL("#/wall", window.location.href);
    window.open(url.toString(), "crewcall-wall", "width=1100,height=800");
  }, []);

  const pulsePaused = demo ? !demo.pulseEnabled : false;

  const togglePulse = useCallback(async () => {
    const nextEnabled = pulsePaused;
    try {
      await setPulse({ enabled: nextEnabled });
      setAlertMessage(null);
      announce(
        nextEnabled
          ? "Community pulse resumed. Seeded neighbours are claiming again."
          : "Community pulse paused. Nothing on the board moves now unless a person moves it.",
      );
    } catch (err) {
      setAlertMessage(errorMessage(err));
    }
  }, [pulsePaused, setPulse, announce]);

  const onSkip = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    // Prefer the list's own id; fall back to the list element, then to <main>, so the
    // first tab stop always lands somewhere real.
    const target =
      document.getElementById("shift-list") ??
      document.querySelector<HTMLElement>(".shift-list") ??
      document.querySelector<HTMLElement>("main");
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus();
    target.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  const openShift = useCallback(
    (shiftId: string) => {
      navigate(`/shift/${shiftId}`);
    },
    [navigate],
  );

  const closeShift = useCallback(() => {
    navigate("/");
  }, [navigate]);

  /* ------------------------------------------------------------- render -- */
  const liveRegions = (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {thresholdMessage}
      </div>
    </>
  );

  if (route.name === "wall") {
    return (
      <>
        <Wall deviceKey={deviceKey} now={now} />
        {liveRegions}
      </>
    );
  }

  const stats = snapshot?.stats;

  return (
    <div className="app">
      <a className="skip-link" href="#shift-list" onClick={onSkip}>
        Skip to shifts
      </a>

      <header className="masthead">
        <div className="masthead__inner">
          <h1 className="wordmark">
            <span className="wordmark__mark" aria-hidden="true" />
            Crewcall
          </h1>

          <p className="masthead__stats">
            {stats ? (
              <>
                <strong className="tnum">{stats.spotsLeftTotal}</strong>{" "}
                {plural(stats.spotsLeftTotal, "spot", "spots")} left today across{" "}
                <strong className="tnum">{stats.projectCount}</strong>{" "}
                {plural(stats.projectCount, "project", "projects")} ·{" "}
                <strong className="tnum">{stats.criticalCount}</strong>{" "}
                {plural(stats.criticalCount, "shift", "shifts")} critical
              </>
            ) : (
              "Loading the board…"
            )}
          </p>

          <div className="masthead__actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={openWall}>
              Open wall display
            </button>

            <span className="row">
              <span className="muted">Community pulse — seeded neighbors, claiming for real</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-pressed={pulsePaused}
                onClick={() => void togglePulse()}
              >
                Pause pulse
              </button>
              <span className="badge">
                {demo === undefined ? "Checking pulse…" : pulsePaused ? "Paused" : "Running"}
              </span>
            </span>

            <span className="row">
              {presence && presence.people.length > 0 ? (
                <span className="presence-rail" aria-hidden="true">
                  {presence.people.map((person, index) => (
                    <span
                      className="glyph"
                      key={`${person.handle}-${index}`}
                      style={accentVars(person.colorIndex)}
                    >
                      {person.glyph}
                    </span>
                  ))}
                </span>
              ) : null}
              <span className="badge">
                {presence === undefined
                  ? "Counting neighbors…"
                  : `${presence.count} ${plural(presence.count, "neighbor", "neighbors")} here now`}
              </span>
            </span>

            <button type="button" className="btn btn--ghost btn--sm" onClick={toggleTheme}>
              {effectiveTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            </button>

            <button
              type="button"
              className="btn btn--secondary btn--sm"
              aria-haspopup="dialog"
              aria-expanded={youOpen}
              aria-label={
                volunteer
                  ? `You are ${volunteer.handle}. Open your profile and commitments.`
                  : "Open your profile and commitments"
              }
              onClick={() => setYouOpen(true)}
            >
              {volunteer ? (
                <>
                  <span
                    className="glyph"
                    aria-hidden="true"
                    style={accentVars(volunteer.colorIndex)}
                  >
                    {volunteer.glyph}
                  </span>
                  <span>{volunteer.handle}</span>
                </>
              ) : (
                <span>Naming you…</span>
              )}
            </button>

            {isRaceWindow ? (
              <span className="badge badge--sim">
                Race-test window — you are a different neighbour here
              </span>
            ) : null}
          </div>
        </div>
      </header>

      {alertMessage ? (
        <p className="notice notice--warn" role="alert">
          {alertMessage}
        </p>
      ) : null}

      {proofDismissed ? null : (
        <div className="proof-strip">
          <span>Two windows? Open the wall display and claim a spot — watch it change.</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setProofDismissed(true)}
          >
            Dismiss this tip
          </button>
        </div>
      )}

      <Board deviceKey={deviceKey} now={now} announce={announce} onOpenShift={openShift} />

      {route.name === "shift" ? (
        <ShiftSheet
          shiftId={route.shiftId}
          deviceKey={deviceKey}
          now={now}
          announce={announce}
          onClose={closeShift}
        />
      ) : null}

      {youOpen ? (
        <YouPopover
          deviceKey={deviceKey}
          now={now}
          volunteer={volunteer}
          announce={announce}
          onClose={() => setYouOpen(false)}
        />
      ) : null}

      {liveRegions}
    </div>
  );
}
