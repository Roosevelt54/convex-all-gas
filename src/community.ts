import { useMemo, useSyncExternalStore } from "react";
import { resolveDeviceKey } from "./identity";

/**
 * Which community's space this tab is looking at. Absent = the public demo community.
 * Remembered per browser so a volunteer who opened an invite link lands back in it.
 */
const KEY = "crewcall.community";
const listeners = new Set<() => void>();

function read(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
let current: string | undefined = read();

export function setCommunityId(id: string | undefined): void {
  current = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the in-memory value still applies for this page's lifetime.
  }
  listeners.forEach((l) => l());
}

export function getCommunityId(): string | undefined {
  return current;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCommunityId(): string | undefined {
  return useSyncExternalStore(subscribe, getCommunityId);
}

/** Args for every community-scoped read: snapshot, activity feed. */
export function useScopeArgs(): { communityId?: string; deviceKey: string } {
  const communityId = useCommunityId();
  return useMemo(() => {
    const deviceKey = resolveDeviceKey();
    return communityId ? { communityId, deviceKey } : { deviceKey };
  }, [communityId]);
}

/** Presence scope for the board or wall of the current community. */
export function presenceScope(base: "board" | "wall", communityId: string | undefined): string {
  return communityId ? `${base}:${communityId}` : base;
}

export function inviteLink(joinCode: string): string {
  return `${window.location.origin}${window.location.pathname}#/join/${joinCode}`;
}
