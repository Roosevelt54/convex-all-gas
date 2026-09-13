import { ConvexError } from "convex/values";
import { MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

export const WINDOW_BACK_MS = 2 * 3600_000;
export const WINDOW_FWD_MS = 7 * 86400_000;
export const OVERLAP_LOOKBACK_MS = 12 * 3600_000;
export const HUMAN_TOUCH_GRACE_MS = 90_000;
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_WRITES = 40;

export type ChangeKind = Doc<"shifts">["lastChangeKind"];
export type ActivityKind = Doc<"activity">["kind"];
export type Alternative = {
  shiftId: Id<"shifts">;
  title: string;
  startsAt: number;
  spotsLeft: number;
};

const ADJECTIVES = [
  "Amber", "Brisk", "Calm", "Dusty", "Eager", "Fern", "Golden", "Hazel",
  "Ivy", "Jolly", "Keen", "Lively", "Maple", "Noble", "Olive", "Patient",
  "Quiet", "River", "Sunny", "Tidy", "Umber", "Vivid", "Willow", "Zesty",
];
const ANIMALS = [
  "Otter", "Sparrow", "Badger", "Heron", "Fox", "Wren", "Marten", "Finch",
  "Beaver", "Swift", "Hare", "Kestrel", "Newt", "Robin", "Vole", "Crane",
];

/** Stable non-cryptographic hash. Deterministic so a device always gets the same name. */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function generateHandle(seed: string): string {
  const h = hashString(seed);
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 7) % ANIMALS.length]}`;
}

export function initials(handle: string): string {
  const parts = handle.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function sanitizeHandle(raw: string): string {
  // Strip control characters and collapse whitespace; newlines must never reach the UI.
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0 || cleaned.length > 24) {
    throw new ConvexError({
      code: "BAD_INPUT",
      message: "Pick a name between 1 and 24 characters.",
    });
  }
  return cleaned;
}

/**
 * Resolves the acting volunteer from the device key and charges them one write against a
 * 40-per-minute budget. No mutation ever accepts a client-supplied volunteerId, so identity
 * cannot be spoofed by editing the request.
 */
export async function requireVolunteer(
  ctx: MutationCtx,
  deviceKey: string,
): Promise<Doc<"volunteers">> {
  const volunteer = await ctx.db
    .query("volunteers")
    .withIndex("by_device_key", (q) => q.eq("deviceKey", deviceKey))
    .unique();
  if (!volunteer) {
    throw new ConvexError({
      code: "NO_IDENTITY",
      message: "Still setting you up — try that again in a moment.",
    });
  }
  const now = Date.now();
  if (now - volunteer.writeWindowStart > RATE_WINDOW_MS) {
    await ctx.db.patch(volunteer._id, { writeWindowStart: now, writeCount: 1, lastSeenAt: now });
  } else if (volunteer.writeCount >= RATE_MAX_WRITES) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "That's a lot of clicks — give it a few seconds.",
    });
  } else {
    await ctx.db.patch(volunteer._id, { writeCount: volunteer.writeCount + 1, lastSeenAt: now });
  }
  return volunteer;
}

/**
 * THE RACE GUARD. Collecting every spot-claim row for the shift puts all of them in this
 * transaction's read set, so any concurrent insert invalidates us and Convex's OCC retries
 * against fresh state. Capacity is always decided from this read, never from filledCount.
 */
export async function readSpotClaims(ctx: MutationCtx, shiftId: Id<"shifts">) {
  return await ctx.db
    .query("claims")
    .withIndex("by_shift_kind_position", (q) => q.eq("shiftId", shiftId).eq("kind", "spot"))
    .collect();
}

/** FIFO-ordered by ascending position, which stays correct after removals from the middle. */
export async function readWaitlist(ctx: MutationCtx, shiftId: Id<"shifts">) {
  return await ctx.db
    .query("claims")
    .withIndex("by_shift_kind_position", (q) => q.eq("shiftId", shiftId).eq("kind", "waitlist"))
    .collect();
}

export function lowestFreePosition(taken: Set<number>, capacity: number): number | null {
  for (let i = 0; i < capacity; i++) if (!taken.has(i)) return i;
  return null;
}

export async function logActivity(
  ctx: MutationCtx,
  args: {
    kind: ActivityKind;
    projectId?: Id<"projects">;
    shiftId?: Id<"shifts">;
    volunteerId?: Id<"volunteers">;
    actorName: string;
    message: string;
    isSim: boolean;
  },
) {
  await ctx.db.insert("activity", { ...args, createdAt: Date.now() });
}

export async function touchShift(
  ctx: MutationCtx,
  shift: Doc<"shifts">,
  opts: {
    kind: ChangeKind;
    actorName: string;
    isSim: boolean;
    patch?: {
      filledCount?: number;
      waitlistCount?: number;
      waitlistSeq?: number;
      capacity?: number;
    };
  },
) {
  const now = Date.now();
  await ctx.db.patch(shift._id, {
    ...(opts.patch ?? {}),
    lastChangeAt: now,
    lastChangeKind: opts.kind,
    lastChangeActorName: opts.actorName,
    lastChangeIsSim: opts.isSim,
    ...(opts.isSim ? {} : { lastHumanTouchAt: now }),
  });
}

export type ClaimResult =
  | { outcome: "already"; kind: "spot" | "waitlist"; position: number }
  | {
      outcome: "conflict";
      conflictShiftId: Id<"shifts">;
      conflictTitle: string;
      conflictStartsAt: number;
    }
  | {
      outcome: "waitlisted";
      rank: number;
      alternative: Alternative | null;
      lastActorName: string;
    }
  | {
      outcome: "claimed" | "reseated";
      position: number;
      requestedPosition: number | null;
      nth: number;
      spotsLeft: number;
    };

/**
 * The single write engine for taking a spot. Both the public mutation and the community
 * pulse call this, so simulated activity travels the identical code path, same transaction,
 * same activity rows, same reactivity. Nothing is mocked.
 */
export async function applyClaim(
  ctx: MutationCtx,
  args: {
    volunteerId: Id<"volunteers">;
    handle: string;
    shiftId: Id<"shifts">;
    preferredPosition?: number;
    isSim: boolean;
  },
): Promise<ClaimResult> {
  const { volunteerId, handle, shiftId, preferredPosition, isSim } = args;
  const now = Date.now();

  const shift = await ctx.db.get(shiftId);
  if (!shift) {
    throw new ConvexError({ code: "GONE", message: "That shift is no longer available." });
  }
  if (shift.status === "cancelled") {
    throw new ConvexError({ code: "CANCELLED", message: "That shift was cancelled." });
  }

  // Idempotency: a double-tap, a retried mutation, or a stale optimistic click can never
  // create a second claim.
  const existing = await ctx.db
    .query("claims")
    .withIndex("by_shift_volunteer", (q) =>
      q.eq("shiftId", shiftId).eq("volunteerId", volunteerId),
    )
    .unique();
  if (existing) {
    return { outcome: "already", kind: existing.kind, position: existing.position };
  }

  // Time overlap against this volunteer's other committed spots. Depends on startsAt/endsAt
  // being denormalized onto the claim; seed.rollForward is the only writer of shift times
  // and it patches every claim it moves, which keeps this honest.
  const nearby = await ctx.db
    .query("claims")
    .withIndex("by_volunteer_starts", (q) =>
      q
        .eq("volunteerId", volunteerId)
        .gte("startsAt", shift.startsAt - OVERLAP_LOOKBACK_MS)
        .lt("startsAt", shift.endsAt),
    )
    .take(20);
  for (const row of nearby) {
    if (row.kind !== "spot") continue;
    if (row.endsAt > shift.startsAt && row.startsAt < shift.endsAt) {
      const other = await ctx.db.get(row.shiftId);
      return {
        outcome: "conflict",
        conflictShiftId: row.shiftId,
        conflictTitle: other?.title ?? "another shift",
        conflictStartsAt: row.startsAt,
      };
    }
  }

  const taken = await readSpotClaims(ctx, shiftId);
  const takenSet = new Set(taken.map((c) => c.position));

  if (taken.length >= shift.capacity) {
    // WAITLIST PATH
    const position = shift.waitlistSeq;
    const insertedId = await ctx.db.insert("claims", {
      shiftId,
      projectId: shift.projectId,
      volunteerId,
      kind: "waitlist",
      position,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      isSeed: isSim,
      createdAt: now,
    });
    const wl = await readWaitlist(ctx, shiftId);
    const rank = wl.findIndex((c) => c._id === insertedId) + 1;

    await touchShift(ctx, shift, {
      kind: "waitlisted",
      actorName: handle,
      isSim,
      patch: {
        waitlistSeq: shift.waitlistSeq + 1,
        waitlistCount: wl.length,
        filledCount: taken.length,
      },
    });
    await logActivity(ctx, {
      kind: "waitlisted",
      projectId: shift.projectId,
      shiftId,
      volunteerId,
      actorName: handle,
      message: `${handle} joined the waitlist for ${shift.title} (#${rank})`,
      isSim,
    });

    // So the loser of a race still gets a good outcome instead of an error toast.
    const busy = nearby.filter((r) => r.kind === "spot");
    const overlaps = (s: Doc<"shifts">) =>
      busy.some((b) => b.endsAt > s.startsAt && b.startsAt < s.endsAt);

    let alternative: Alternative | null = null;
    const sameProject = await ctx.db
      .query("shifts")
      .withIndex("by_project_start", (q) =>
        q
          .eq("projectId", shift.projectId)
          .gte("startsAt", now)
          .lte("startsAt", now + WINDOW_FWD_MS),
      )
      .take(10);
    let pick = sameProject.find(
      (s) =>
        s._id !== shiftId && s.status === "open" && s.filledCount < s.capacity && !overlaps(s),
    );
    if (!pick) {
      const anywhere = await ctx.db
        .query("shifts")
        .withIndex("by_status_start", (q) =>
          q.eq("status", "open").gte("startsAt", now).lte("startsAt", now + WINDOW_FWD_MS),
        )
        .take(40);
      const open = anywhere.filter(
        (s) => s._id !== shiftId && s.filledCount < s.capacity && !overlaps(s),
      );
      pick = open.find((s) => s.skillTag === shift.skillTag) ?? open[0];
    }
    if (pick) {
      alternative = {
        shiftId: pick._id,
        title: pick.title,
        startsAt: pick.startsAt,
        spotsLeft: pick.capacity - pick.filledCount,
      };
    }

    return { outcome: "waitlisted", rank, alternative, lastActorName: shift.lastChangeActorName };
  }

  // SPOT PATH
  const usePreferred =
    preferredPosition !== undefined &&
    Number.isInteger(preferredPosition) &&
    preferredPosition >= 0 &&
    preferredPosition < shift.capacity &&
    !takenSet.has(preferredPosition);
  const chosen = usePreferred
    ? (preferredPosition as number)
    : (lowestFreePosition(takenSet, shift.capacity) as number);
  const reseated = preferredPosition !== undefined && chosen !== preferredPosition;

  await ctx.db.insert("claims", {
    shiftId,
    projectId: shift.projectId,
    volunteerId,
    kind: "spot",
    position: chosen,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    isSeed: isSim,
    createdAt: now,
  });

  const filled = taken.length + 1;
  await touchShift(ctx, shift, {
    kind: "claimed",
    actorName: handle,
    isSim,
    patch: { filledCount: filled },
  });
  await logActivity(ctx, {
    kind: reseated ? "reseated" : "claimed",
    projectId: shift.projectId,
    shiftId,
    volunteerId,
    actorName: handle,
    message: `${handle} took a spot at ${shift.title} — ${shift.capacity - filled} left`,
    isSim,
  });
  if (filled === shift.capacity) {
    await logActivity(ctx, {
      kind: "filled",
      projectId: shift.projectId,
      shiftId,
      actorName: handle,
      message: `${shift.title} is full — waitlist open`,
      isSim,
    });
  }

  return {
    outcome: reseated ? "reseated" : "claimed",
    position: chosen,
    requestedPosition: preferredPosition ?? null,
    nth: filled,
    spotsLeft: shift.capacity - filled,
  };
}

export type ReleaseResult =
  | { outcome: "left_waitlist" }
  | { outcome: "released"; promoted: { handle: string } | null };

/**
 * Releasing a spot promotes the FIFO head of the waitlist into the exact vacated position in
 * the same transaction — which is why a release in one window is visibly a promotion in every
 * other window, with no extra machinery.
 */
export async function applyRelease(
  ctx: MutationCtx,
  args: {
    volunteerId: Id<"volunteers">;
    handle: string;
    shiftId: Id<"shifts">;
    isSim: boolean;
  },
): Promise<ReleaseResult> {
  const { volunteerId, handle, shiftId, isSim } = args;
  const now = Date.now();

  const shift = await ctx.db.get(shiftId);
  if (!shift) {
    throw new ConvexError({ code: "GONE", message: "That shift is no longer available." });
  }

  const mine = await ctx.db
    .query("claims")
    .withIndex("by_shift_volunteer", (q) =>
      q.eq("shiftId", shiftId).eq("volunteerId", volunteerId),
    )
    .unique();
  if (!mine) {
    throw new ConvexError({ code: "NOT_YOURS", message: "You don't have a spot on that shift." });
  }

  if (mine.kind === "waitlist") {
    await ctx.db.delete(mine._id);
    const wl = await readWaitlist(ctx, shiftId);
    await touchShift(ctx, shift, {
      kind: "released",
      actorName: handle,
      isSim,
      patch: { waitlistCount: wl.length },
    });
    await logActivity(ctx, {
      kind: "released",
      projectId: shift.projectId,
      shiftId,
      volunteerId,
      actorName: handle,
      message: `${handle} left the waitlist for ${shift.title}`,
      isSim,
    });
    return { outcome: "left_waitlist" };
  }

  const vacated = mine.position;
  await ctx.db.delete(mine._id);

  const wl = await readWaitlist(ctx, shiftId);
  if (wl.length > 0) {
    const head = wl[0];
    const headVol = await ctx.db.get(head.volunteerId);
    await ctx.db.delete(head._id);
    await ctx.db.insert("claims", {
      shiftId,
      projectId: shift.projectId,
      volunteerId: head.volunteerId,
      kind: "spot",
      position: vacated,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      isSeed: head.isSeed,
      createdAt: now,
    });
    const spots = await readSpotClaims(ctx, shiftId);
    const wlAfter = await readWaitlist(ctx, shiftId);
    const promotedName = headVol?.handle ?? "A neighbor";
    await touchShift(ctx, shift, {
      kind: "promoted",
      actorName: promotedName,
      isSim,
      patch: { filledCount: spots.length, waitlistCount: wlAfter.length },
    });
    await logActivity(ctx, {
      kind: "released",
      projectId: shift.projectId,
      shiftId,
      volunteerId,
      actorName: handle,
      message: `${handle} released a spot at ${shift.title}`,
      isSim,
    });
    await logActivity(ctx, {
      kind: "promoted",
      projectId: shift.projectId,
      shiftId,
      volunteerId: head.volunteerId,
      actorName: promotedName,
      message: `${promotedName} moved off the waitlist into ${shift.title}`,
      isSim,
    });
    return { outcome: "released", promoted: { handle: promotedName } };
  }

  const spots = await readSpotClaims(ctx, shiftId);
  await touchShift(ctx, shift, {
    kind: "released",
    actorName: handle,
    isSim,
    patch: { filledCount: spots.length },
  });
  await logActivity(ctx, {
    kind: "released",
    projectId: shift.projectId,
    shiftId,
    volunteerId,
    actorName: handle,
    message: `${handle} released a spot at ${shift.title} — ${shift.capacity - spots.length} left`,
    isSim,
  });
  return { outcome: "released", promoted: null };
}
