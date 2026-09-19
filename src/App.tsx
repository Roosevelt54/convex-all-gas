import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
} from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import { resolveDeviceKey, wantsFreshIdentity } from "./identity";
import {
  prefersReducedMotion,
  routeHref,
  useAnnouncer,
  useClock,
  useHashRoute,
  usePersistentFlag,
} from "./util";
import Board from "./components/Board";
import CommunityBar from "./components/CommunityBar";
import { presenceScope, useCommunityId, useScopeArgs } from "./community";
import ShiftSheet from "./components/ShiftSheet";
import Wall from "./components/Wall";
import Organize from "./components/Organize";
import YouPopover from "./components/YouPopover";
import AccountDialog from "./components/AccountDialog";
import WelcomeDialog from "./components/WelcomeDialog";
import { PersonName } from "./components/Person";

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

const NAME_SKIPPED_KEY = "crewcall.nameSkipped";

function readNameSkipped(): boolean {
  try {
    return localStorage.getItem(NAME_SKIPPED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fires an OS notification only when the person already granted permission. Never asks here. */
function notifyOpened(title: string, onClick: () => void): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const note = new Notification(`${title} is open — claim a spot`, {
      body: "A shift you asked to hear about just opened on Crewcall.",
    });
    note.onclick = () => {
      window.focus();
      onClick();
      note.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker. The in-app alert and
    // the polite announcement still cover it.
  }
}

type AccountMode = "signIn" | "signUp";
type OpenedNotice = { shiftId: string; title: string };

export default function App(): JSX.Element {
  /* ----------------------------------------------------------- identity -- */
  // Resolved ONCE. Re-resolving on every render would mint a new neighbour under
  // the race-test window and quietly break the contention demo.
  const [deviceKey] = useState<string>(() => resolveDeviceKey());
  const [isRaceWindow] = useState<boolean>(() => wantsFreshIdentity());

  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();

  const ensure = useMutation(api.volunteers.ensure);
  const [ensured, setEnsured] = useState<{
    handle: string;
    glyph: string;
    colorIndex: number;
    verified: boolean;
  } | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  // The auth state the last ensure() was requested for; null = never requested yet.
  const ensuredForRef = useRef<boolean | null>(null);

  useEffect(() => {
    // Wait for Convex Auth to settle so a signed-in visitor is not first ensured as a guest.
    if (authLoading) return;
    // One request per identity: on load, then again whenever sign-in state flips (sign-in links
    // this device's guest row to the account; sign-out hands the device a fresh guest).
    // The ref makes StrictMode's double-invoked effect fire the upsert once per identity.
    // Deliberately NO cleanup/"alive" guard: StrictMode's simulated unmount would flip that
    // guard on the only in-flight request, and the early return on remount means no second
    // request exists to take its place — identityReady would never become true and the
    // presence heartbeat would never start. setState after unmount is a no-op in React 18+.
    if (ensuredForRef.current === isAuthenticated) return;
    ensuredForRef.current = isAuthenticated;
    void ensure({ deviceKey })
      .then((volunteer) => {
        setEnsured({
          handle: volunteer.handle,
          glyph: volunteer.glyph,
          colorIndex: volunteer.colorIndex,
          verified: volunteer.verified,
        });
      })
      .catch(() => {
        // A failed upsert must not blank the page; reads and presence still work.
      })
      .finally(() => {
        setIdentityReady(true);
      });
  }, [ensure, deviceKey, authLoading, isAuthenticated]);

  /* ------------------------------------------------------------- shared -- */
  const now = useClock(30_000);
  const [announcement, announce] = useAnnouncer();
  const [route, navigate] = useHashRoute();

  // Live "who am I": re-runs after a rename, a sign-in or a sign-out.
  const me = useQuery(api.volunteers.me, { deviceKey });
  const volunteer = me ?? ensured;

  const mine = useQuery(api.board.myCommitments, { deviceKey });
  const scopeArgs = useScopeArgs();
  const communityId = useCommunityId();
  const snapshot = useQuery(api.board.snapshot, scopeArgs);
  const demo = useQuery(api.meta.demoState, {});
  const presence = useQuery(api.presence.onScope, {
    scope: presenceScope("board", communityId),
    deviceKey,
  });

  const setPulse = useMutation(api.meta.setPulse);
  const ping = useMutation(api.presence.ping);
  const leave = useMutation(api.presence.leave);

  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [youOpen, setYouOpen] = useState(false);
  const [accountMode, setAccountMode] = useState<AccountMode | null>(null);
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
  const scope = presenceScope(route.name === "wall" ? "wall" : "board", communityId);

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

  /* ----------------------------------------------------------- accounts -- */
  // Deep entry points (organize screen, shift sheet, name step) are nearly always a guest who
  // needs an account, so they open on "Create account"; the masthead button opens "Sign in".
  // The two modes are one tap apart inside the dialog.
  const openAccount = useCallback(() => {
    setYouOpen(false);
    setAccountMode("signUp");
  }, []);

  const closeAccount = useCallback(() => setAccountMode(null), []);

  const doSignOut = useCallback(async () => {
    try {
      await signOut();
      setAlertMessage(null);
      announce("Signed out. You are browsing as a guest now; your spots stay with your account.");
      setYouOpen(false);
    } catch (err) {
      setAlertMessage(errorMessage(err));
    }
  }, [signOut, announce]);

  /* -------------------------------------------------------- name step -- */
  const [nameSkipped, setNameSkipped] = useState<boolean>(() => readNameSkipped());
  const [welcomeClosed, setWelcomeClosed] = useState(false);

  const skipNameStep = useCallback(() => {
    setNameSkipped(true);
    try {
      localStorage.setItem(NAME_SKIPPED_KEY, "1");
    } catch {
      // Private mode: skipped for this page's lifetime only.
    }
  }, []);

  // Rendered over an already-live board; it never gates loading.
  const welcomeMe =
    !welcomeClosed &&
    !nameSkipped &&
    !isRaceWindow &&
    !authLoading &&
    !isAuthenticated &&
    me &&
    me.nameChosen === false &&
    // Never stack two modal dialogs: wait until nothing else is open.
    route.name !== "shift" &&
    accountMode === null &&
    !youOpen
      ? me
      : null;

  /* ------------------------------------------------- "Notify me" watcher -- */
  // Detected from subscription data: the server's scheduled function flips status to "open",
  // and the snapshot subscription delivers it. The previous status per interested shift lives
  // in a ref, so the first load (shifts that were already open) never alerts.
  const interests = mine?.interests;
  const shifts = snapshot?.shifts;
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const [openedNotices, setOpenedNotices] = useState<OpenedNotice[]>([]);

  useEffect(() => {
    if (interests === undefined || shifts === undefined) return;
    const byId = new Map<string, (typeof shifts)[number]>(shifts.map((s) => [s._id, s]));
    const prev = prevStatusRef.current;
    const next = new Map<string, string>();
    const opened: OpenedNotice[] = [];
    for (const id of interests) {
      const shift = byId.get(id);
      if (!shift) continue;
      if (prev.get(id) === "scheduled" && shift.status === "open") {
        opened.push({ shiftId: id, title: shift.title });
      }
      next.set(id, shift.status);
    }
    prevStatusRef.current = next;
    if (opened.length === 0) return;

    setOpenedNotices((current) => [
      ...current.filter((n) => !opened.some((o) => o.shiftId === n.shiftId)),
      ...opened,
    ]);
    announce(
      opened.length === 1
        ? `${opened[0].title} is open — claim a spot.`
        : `${opened.length} shifts you asked about are open: ${opened
            .map((o) => o.title)
            .join(", ")}.`,
    );
    for (const o of opened) notifyOpened(o.title, () => openShift(o.shiftId));
  }, [interests, shifts, announce, openShift]);

  const dismissNotice = useCallback((shiftId: string) => {
    setOpenedNotices((current) => current.filter((n) => n.shiftId !== shiftId));
  }, []);

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
  const onOrganize = route.name === "organize";
  const verified = volunteer?.verified ?? false;

  return (
    <div className="app">
      <a className="skip-link" href="#shift-list" onClick={onSkip}>
        {onOrganize ? "Skip to main content" : "Skip to shifts"}
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
                {stats.opensSoonCount > 0 ? (
                  <>
                    {" "}
                    · <strong className="tnum">{stats.opensSoonCount}</strong>{" "}
                    {plural(stats.opensSoonCount, "shift opens", "shifts open")} soon
                  </>
                ) : null}
              </>
            ) : (
              "Loading the board…"
            )}
          </p>

          <div className="masthead__actions">
            {onOrganize ? (
              <a className="btn btn--secondary btn--sm" href={routeHref("/")}>
                Back to the board
              </a>
            ) : (
              <a className="btn btn--secondary btn--sm" href={routeHref("/organize")}>
                Organize shifts
              </a>
            )}

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
                  ? `You are ${volunteer.handle}${
                      verified ? ", verified account" : ", guest"
                    }. Open your profile and commitments.`
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
                  {verified ? (
                    <PersonName handle={volunteer.handle} verified />
                  ) : (
                    <span>{volunteer.handle}</span>
                  )}
                </>
              ) : (
                <span>Naming you…</span>
              )}
            </button>

            {authLoading ? null : isAuthenticated ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void doSignOut()}
              >
                Sign out
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                aria-haspopup="dialog"
                onClick={() => setAccountMode("signIn")}
              >
                Sign in
              </button>
            )}

            {isRaceWindow ? (
              <span className="badge badge--sim">
                Race-test window — you are a different neighbour here
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <CommunityBar deviceKey={deviceKey} route={route} navigate={navigate} identityReady={identityReady} />

      {alertMessage ? (
        <p className="notice notice--warn" role="alert">
          {alertMessage}
        </p>
      ) : null}

      {openedNotices.length > 0 ? (
        // Deliberately not a live region: each opening is announced once via the polite region.
        <section className="stack" aria-label="Shifts you asked to hear about">
          {openedNotices.map((n) => (
            <div className="notice notice--good" key={n.shiftId}>
              <p>
                <strong>{n.title}</strong> is open — claim a spot.
              </p>
              <p className="row">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => {
                    dismissNotice(n.shiftId);
                    openShift(n.shiftId);
                  }}
                >
                  Open {n.title}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label={`Dismiss the notice about ${n.title}`}
                  onClick={() => dismissNotice(n.shiftId)}
                >
                  Dismiss
                </button>
              </p>
            </div>
          ))}
        </section>
      ) : null}

      {proofDismissed || onOrganize ? null : (
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

      {onOrganize ? (
        <Organize
          deviceKey={deviceKey}
          now={now}
          announce={announce}
          onOpenAccount={openAccount}
          onOpenShift={openShift}
        />
      ) : (
        <Board deviceKey={deviceKey} now={now} announce={announce} onOpenShift={openShift} />
      )}

      {route.name === "shift" ? (
        <ShiftSheet
          shiftId={route.shiftId}
          deviceKey={deviceKey}
          now={now}
          announce={announce}
          onClose={closeShift}
          onOpenAccount={openAccount}
        />
      ) : null}

      {youOpen ? (
        <YouPopover
          deviceKey={deviceKey}
          now={now}
          volunteer={volunteer}
          announce={announce}
          onClose={() => setYouOpen(false)}
          onOpenAccount={openAccount}
          onSignOut={doSignOut}
        />
      ) : null}

      {welcomeMe ? (
        <WelcomeDialog
          deviceKey={deviceKey}
          currentHandle={welcomeMe.handle}
          announce={announce}
          onJoined={() => setWelcomeClosed(true)}
          onSkip={() => {
            skipNameStep();
            setWelcomeClosed(true);
          }}
          onOpenAccount={() => {
            setWelcomeClosed(true);
            setAccountMode("signUp");
          }}
        />
      ) : null}

      {accountMode !== null ? (
        <AccountDialog
          deviceKey={deviceKey}
          initialMode={accountMode}
          announce={announce}
          onClose={closeAccount}
        />
      ) : null}

      {liveRegions}
    </div>
  );
}
