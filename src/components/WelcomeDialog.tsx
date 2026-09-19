import { useCallback, useId, useRef, useState, type FormEvent, type JSX } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEscape, useFocusTrap } from "../util";
import "./WelcomeDialog.css";

/** A ConvexError surfaces as err.data = {code, message}. Never show a stack trace. */
function errorMessage(err: unknown): string {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Something went wrong. Try that again in a moment.";
}

/**
 * First-open name step: "What should neighbours call you?". Shown once, skippable, and rendered
 * ON TOP of an already-live board — it never gates loading or browsing.
 */
export default function WelcomeDialog(props: {
  deviceKey: string;
  currentHandle: string;
  announce: (msg: string) => void;
  onJoined: () => void;
  onSkip: () => void;
  onOpenAccount: () => void;
}): JSX.Element {
  const { deviceKey, currentHandle, announce, onJoined, onSkip, onOpenAccount } = props;

  const trapRef = useFocusTrap(true);
  useEscape(onSkip, true);

  const rename = useMutation(api.volunteers.rename);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const uid = useId();
  const ids = {
    title: `${uid}-title`,
    intro: `${uid}-intro`,
    input: `${uid}-name`,
    hint: `${uid}-hint`,
    error: `${uid}-error`,
  };

  const showError = useCallback(
    (message: string) => {
      setError(message);
      // Focus reads label + invalid + error once; if already focused, announce instead.
      const el = inputRef.current;
      if (el && document.activeElement !== el) el.focus();
      else announce(message);
    },
    [announce],
  );

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy) return;
      const next = name.trim();
      if (next.length < 1 || next.length > 24) {
        showError("Enter a name between 1 and 24 characters.");
        return;
      }
      setBusy(true);
      try {
        const result = await rename({ deviceKey, handle: next });
        setError(null);
        announce(`Welcome, ${result.handle}. Neighbours will see that name when you claim a spot.`);
        onJoined();
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, name, rename, deviceKey, announce, onJoined, showError],
  );

  return (
    <div className="backdrop">
      <div
        className="sheet welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={ids.intro}
        ref={trapRef}
      >
        <div className="stack">
          <h2 id={ids.title}>Welcome to Crewcall</h2>
          <p id={ids.intro} className="muted">
            Claim volunteer spots on neighbourhood projects — no account needed. Pick a name so
            organizers know who is coming.
          </p>
        </div>

        <form className="stack" noValidate onSubmit={(event) => void onSubmit(event)}>
          <div className="welcome__field">
            <label htmlFor={ids.input}>What should neighbours call you?</label>
            <input
              id={ids.input}
              ref={inputRef}
              type="text"
              value={name}
              maxLength={24}
              autoComplete="nickname"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${ids.hint} ${ids.error}` : ids.hint}
              onChange={(event) => setName(event.target.value)}
            />
            <p id={ids.hint} className="welcome__hint">
              1–24 characters. Right now you are “{currentHandle}”.
            </p>
            {error ? (
              <p id={ids.error} className="welcome__error">
                {error}
              </p>
            ) : null}
          </div>

          <div className="welcome__actions">
            <button type="submit" className="btn btn--primary" aria-disabled={busy}>
              {busy ? "Joining…" : "Join the board"}
            </button>
            <button type="button" className="btn btn--secondary" onClick={onOpenAccount}>
              Sign in or create an account
            </button>
            <button type="button" className="btn btn--ghost" onClick={onSkip}>
              Just browse
            </button>
          </div>
        </form>

        <p className="welcome__note">
          An account adds a ✓ next to your name so organizers know it is really you, and lets you
          post shifts. It is optional.
        </p>
      </div>
    </div>
  );
}
