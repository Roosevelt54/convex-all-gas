const STORAGE_KEY = "crewcall.deviceKey";

function mintKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for the rare browser without randomUUID. Not a security boundary either way.
  return `dk-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function safeGet(store: Storage | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    // Private mode / blocked site data.
    return null;
  }
}

function safeSet(store: Storage | undefined, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Nothing we can do; the key stays in memory for this page's lifetime.
  }
}

/** True when the hash carries `as=new`, e.g. `#/shift/abc?as=new`. */
export function wantsFreshIdentity(): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash;
  const q = hash.indexOf("?");
  if (q === -1) return false;
  return new URLSearchParams(hash.slice(q + 1)).get("as") === "new";
}

/**
 * Device-scoped pseudonymous identity. No provider, no password, no gate.
 *
 * The sessionStorage-before-localStorage order is LOAD-BEARING, not incidental. The
 * "Race test — open as another neighbour" link appends `as=new`, which mints a fresh key into
 * sessionStorage ONLY. Without that override two tabs on one laptop share localStorage, become
 * the same person, and the headline contention demo silently fails — the second window would
 * just toggle the first window's own claim.
 *
 * This key is a bearer capability appropriate for a neighborhood coordination board. It is
 * explicitly NOT a security boundary: a new browser is a new neighbor. The upgrade path is to
 * replace the body of requireVolunteer() on the server with ctx.auth.getUserIdentity(); every
 * call site is already shaped for it.
 */
export function resolveDeviceKey(): string {
  const ss = typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
  const ls = typeof localStorage !== "undefined" ? localStorage : undefined;

  if (wantsFreshIdentity()) {
    // Reuse the per-tab key across reloads of that same tab, so refreshing the race-test
    // window does not spawn yet another neighbor.
    const existing = safeGet(ss, STORAGE_KEY);
    if (existing) return existing;
    const fresh = mintKey();
    safeSet(ss, STORAGE_KEY, fresh);
    return fresh;
  }

  const fromSession = safeGet(ss, STORAGE_KEY);
  if (fromSession) return fromSession;

  const fromLocal = safeGet(ls, STORAGE_KEY);
  if (fromLocal) return fromLocal;

  const minted = mintKey();
  safeSet(ls, STORAGE_KEY, minted);
  return minted;
}
