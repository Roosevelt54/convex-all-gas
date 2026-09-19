import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import { useEscape, useFocusTrap } from "../util";
import "./AccountDialog.css";

type Mode = "signIn" | "signUp";
type Field = "username" | "name" | "password";
type FieldErrors = Partial<Record<Field, string>>;

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const USERNAME_RULE = "Usernames are 3–20 letters, numbers or _ (no spaces, no email).";
const PASSWORD_RULE = "Passwords need at least 8 characters.";

/**
 * Convex Auth reports failures as plain Error messages (InvalidSecret, InvalidAccountId,
 * "… already exists"); our own profile/password validation throws ConvexError with data.message.
 * Map both to human copy, and to the field it is about when there is one.
 */
function authFailure(err: unknown): { field: Field | "form"; message: string } {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  let message: string | null = null;
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) message = m;
  }
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";

  if (message === null) {
    if (/InvalidSecret|InvalidAccountId/.test(raw)) {
      return { field: "form", message: "Wrong username or password." };
    }
    if (/already exists/i.test(raw)) {
      return { field: "username", message: "That username is taken." };
    }
    if (/TooManyFailedAttempts/i.test(raw)) {
      return { field: "form", message: "Too many tries. Wait a few minutes, then try again." };
    }
    if (/Usernames are/.test(raw)) message = USERNAME_RULE;
    else if (/Passwords need/.test(raw)) message = PASSWORD_RULE;
    else return { field: "form", message: "Could not sign you in just now. Try again in a moment." };
  }
  if (/^Username/i.test(message)) return { field: "username", message };
  if (/^Password/i.test(message)) return { field: "password", message };
  return { field: "form", message };
}

export default function AccountDialog(props: {
  deviceKey: string;
  initialMode?: "signIn" | "signUp";
  announce: (msg: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { deviceKey, initialMode = "signIn", announce, onClose } = props;

  const trapRef = useFocusTrap(true);
  useEscape(onClose, true);

  const { signIn } = useAuthActions();
  const me = useQuery(api.volunteers.me, { deviceKey });

  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<{ message: string; attempt: number } | null>(null);
  const attemptRef = useRef(0);

  const uid = useId();
  const ids = {
    title: `${uid}-title`,
    explain: `${uid}-explain`,
    username: `${uid}-username`,
    usernameHint: `${uid}-username-hint`,
    usernameError: `${uid}-username-error`,
    name: `${uid}-name`,
    nameHint: `${uid}-name-hint`,
    nameError: `${uid}-name-error`,
    password: `${uid}-password`,
    passwordHint: `${uid}-password-hint`,
    passwordError: `${uid}-password-error`,
  };

  const usernameRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  // Display name defaults to the guest name this device already goes by, until they type.
  const nameTouchedRef = useRef(false);
  useEffect(() => {
    if (nameTouchedRef.current || !me || me.verified) return;
    setDisplayName(me.handle);
  }, [me]);

  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    setFieldErrors({});
    setFormError(null);
  }, []);

  /**
   * Moving focus to the first invalid field makes the screen reader read its label, "invalid"
   * and its error (via aria-describedby) — exactly once. If focus is already there, a focus()
   * call is silent, so announce the error instead.
   */
  const revealFieldError = useCallback(
    (errors: FieldErrors) => {
      const order: Array<[Field, HTMLInputElement | null]> = [
        ["username", usernameRef.current],
        ["name", nameRef.current],
        ["password", passwordRef.current],
      ];
      for (const [field, el] of order) {
        const message = errors[field];
        if (!message || !el) continue;
        if (document.activeElement === el) announce(message);
        else el.focus();
        return;
      }
    },
    [announce],
  );

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy) return;

      const u = username.trim().toLowerCase();
      const name = displayName.trim();
      const errors: FieldErrors = {};
      if (!USERNAME_RE.test(u)) errors.username = USERNAME_RULE;
      if (mode === "signUp" && name.length > 24) {
        errors.name = "Display names are up to 24 characters.";
      }
      if (password.length < 8) errors.password = PASSWORD_RULE;

      setFormError(null);
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) {
        revealFieldError(errors);
        return;
      }

      setBusy(true);
      try {
        const result = await signIn(
          "password",
          mode === "signUp"
            ? name.length > 0
              ? { username: u, password, name, flow: "signUp" }
              : { username: u, password, flow: "signUp" }
            : { username: u, password, flow: "signIn" },
        );
        if (!result.signingIn) {
          attemptRef.current += 1;
          setFormError({
            message: "Could not finish signing you in. Try again in a moment.",
            attempt: attemptRef.current,
          });
          return;
        }
        announce(
          mode === "signUp"
            ? `Signed in as ${name.length > 0 ? name : u}. Your spots moved to your account.`
            : `Signed in as ${u}.`,
        );
        onClose();
      } catch (err) {
        const failure = authFailure(err);
        if (failure.field === "form") {
          attemptRef.current += 1;
          setFormError({ message: failure.message, attempt: attemptRef.current });
        } else {
          const next: FieldErrors = { [failure.field]: failure.message };
          setFieldErrors(next);
          revealFieldError(next);
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, username, displayName, password, mode, signIn, announce, onClose, revealFieldError],
  );

  const describedBy = (hint: string | null, field: Field, errorId: string): string | undefined => {
    const parts = [hint, fieldErrors[field] ? errorId : null].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
  };

  const creating = mode === "signUp";

  return (
    <div className="backdrop">
      <div
        className="sheet account"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={ids.explain}
        ref={trapRef}
      >
        <div className="sheet__head">
          <h2 id={ids.title}>{creating ? "Create an account" : "Sign in"}</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>

        <form className="stack" noValidate onSubmit={(event) => void onSubmit(event)}>
          <fieldset className="account__modes">
            <legend className="account__legend">Do you already have an account?</legend>
            <div className="account__seg">
              <label className="account__seg-option">
                <input
                  type="radio"
                  name={`${uid}-mode`}
                  value="signIn"
                  checked={mode === "signIn"}
                  onChange={() => switchMode("signIn")}
                />
                <span>Sign in</span>
              </label>
              <label className="account__seg-option">
                <input
                  type="radio"
                  name={`${uid}-mode`}
                  value="signUp"
                  checked={mode === "signUp"}
                  onChange={() => switchMode("signUp")}
                />
                <span>Create account</span>
              </label>
            </div>
          </fieldset>

          <div className="account__field">
            <label htmlFor={ids.username}>Username</label>
            <input
              id={ids.username}
              ref={usernameRef}
              type="text"
              name="username"
              value={username}
              maxLength={20}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={describedBy(ids.usernameHint, "username", ids.usernameError)}
              onChange={(event) => setUsername(event.target.value)}
            />
            <p id={ids.usernameHint} className="account__hint">
              3–20 letters, numbers or _. Not an email address.
            </p>
            {fieldErrors.username ? (
              <p id={ids.usernameError} className="account__error">
                {fieldErrors.username}
              </p>
            ) : null}
          </div>

          {creating ? (
            <div className="account__field">
              <label htmlFor={ids.name}>Display name</label>
              <input
                id={ids.name}
                ref={nameRef}
                type="text"
                name="name"
                value={displayName}
                maxLength={24}
                autoComplete="nickname"
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={describedBy(ids.nameHint, "name", ids.nameError)}
                onChange={(event) => {
                  nameTouchedRef.current = true;
                  setDisplayName(event.target.value);
                }}
              />
              <p id={ids.nameHint} className="account__hint">
                What neighbours see next to your ✓. Leave it blank to use your username.
              </p>
              {fieldErrors.name ? (
                <p id={ids.nameError} className="account__error">
                  {fieldErrors.name}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="account__field">
            <label htmlFor={ids.password}>Password</label>
            <div className="account__password">
              <input
                id={ids.password}
                ref={passwordRef}
                type={showPassword ? "text" : "password"}
                name="password"
                value={password}
                maxLength={128}
                autoComplete={creating ? "new-password" : "current-password"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={describedBy(
                  creating ? ids.passwordHint : null,
                  "password",
                  ids.passwordError,
                )}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                aria-pressed={showPassword}
                aria-controls={ids.password}
                onClick={() => setShowPassword((v) => !v)}
              >
                Show password
              </button>
            </div>
            {creating ? (
              <p id={ids.passwordHint} className="account__hint">
                At least 8 characters.
              </p>
            ) : null}
            {fieldErrors.password ? (
              <p id={ids.passwordError} className="account__error">
                {fieldErrors.password}
              </p>
            ) : null}
          </div>

          {formError ? (
            <p key={formError.attempt} className="notice notice--warn" role="alert">
              {formError.message}
            </p>
          ) : null}

          <div className="row">
            <button type="submit" className="btn btn--primary" aria-disabled={busy}>
              {busy
                ? creating
                  ? "Creating your account…"
                  : "Signing in…"
                : creating
                  ? "Create account and sign in"
                  : "Sign in"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Keep browsing as a guest
            </button>
          </div>
        </form>

        <div id={ids.explain} className="account__explain stack">
          <p>
            No email needed — just a username and a password. A <strong>✓</strong> next to your
            name tells organizers it is really you, not someone who typed the same name.
          </p>
          <p className="muted">
            An account is only needed to post shifts. Browsing, claiming a spot, joining a waitlist
            and “Notify me” all work as a guest.
          </p>
        </div>
      </div>
    </div>
  );
}
