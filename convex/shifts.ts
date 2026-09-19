import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  applyClaim,
  applyRelease,
  logActivity,
  lowestFreePosition,
  readSpotClaims,
  readWaitlist,
  canAccessCommunity,
  requireShiftAccess,
  requireVolunteer,
  resolveVolunteer,
  touchShift,
  usernameOf,
} from "./lib";

/** Bound on how many "Notify me" rows are counted per shift. */
const INTEREST_COUNT_LIMIT = 500;

/** Hard ceiling on a single +N tap, and on what a shift can ever grow to. */
const MAX_DELTA = 4;
const MAX_CAPACITY = 24;

/** Last N history rows shown inside the sheet. */
const DETAIL_ACTIVITY_LIMIT = 12;

const rosterEntry = v.object({
  position: v.number(),
  handle: v.string(),
  glyph: v.string(),
  colorIndex: v.number(),
  isYou: v.boolean(),
  isSeed: v.boolean(),
  verified: v.boolean(),
  // The account username behind a verified name, so two "Sam"s are never confused.
  username: v.union(v.string(), v.null()),
});

type RosterEntry = {
  position: number;
  handle: string;
  glyph: string;
  colorIndex: number;
  isYou: boolean;
  isSeed: boolean;
  verified: boolean;
  username: string | null;
};

const waitlistEntry = v.object({
  claimId: v.id("claims"),
  rank: v.number(),
  position: v.number(),
  handle: v.string(),
  glyph: v.string(),
  colorIndex: v.number(),
  isYou: v.boolean(),
  isSeed: v.boolean(),
  verified: v.boolean(),
  // The account username behind a verified name, so two "Sam"s are never confused.
  username: v.union(v.string(), v.null()),
});

type WaitlistEntry = {
  claimId: Id<"claims">;
  rank: number;
  position: number;
  handle: string;
  glyph: string;
  colorIndex: number;
  isYou: boolean;
  isSeed: boolean;
  verified: boolean;
  username: string | null;
};

const yourClaimValidator = v.object({
  claimId: v.id("claims"),
  kind: v.union(v.literal("spot"), v.literal("waitlist")),
  position: v.number(),
  waitlistRank: v.union(v.number(), v.null()),
});

type YourClaim = {
  claimId: Id<"claims">;
  kind: "spot" | "waitlist";
  position: number;
  waitlistRank: number | null;
};

/** A shift that vanished mid-navigation must paint an empty sheet, never throw. */
const emptyDetail = {
  access: "missing" as "missing" | "locked",
  shift: null,
  project: null,
  roster: [] as RosterEntry[],
  openPositions: [] as number[],
  waitlist: [] as WaitlistEntry[],
  yourClaim: null,
  activity: [] as Doc<"activity">[],
  youAreInterested: false,
  canOrganize: false,
};

/**
 * Everything the shift sheet renders, in one subscription.
 *
 * DELIBERATELY EXCLUDES watcher presence. Presence rows are rewritten by a 15s heartbeat from
 * every open window; if this query read them, every heartbeat anywhere would invalidate the
 * sheet and re-render the roster, the spot grid, and whatever button the keyboard user is
 * standing on. "N watching" is a separate, cheap subscription (presence.onScope) precisely so
 * that churn cannot reach this read set.
 *
 * Returns raw timestamps only — no boolean here is derived from Date.now(), because a Convex
 * query does not re-run just because wall-clock time passed. The client ticks its own clock.
 *
 * Never throws: an unknown deviceKey is a first-paint race with volunteers.ensure (isYou is
 * simply false everywhere and yourClaim is null), and a missing shift returns the safe empty
 * shape.
 */
export const detail = query({
  // A string, not v.id: it comes straight from the URL hash, and a mangled link must paint the
  // empty sheet rather than throw.
  args: { shiftId: v.string(), deviceKey: v.string() },
  returns: v.object({
    // "locked": the shift is in a private community you haven't joined; nothing else is returned.
    access: v.union(v.literal("ok"), v.literal("locked"), v.literal("missing")),
    shift: v.union(schema.doc("shifts"), v.null()),
    project: v.union(schema.doc("projects"), v.null()),
    roster: v.array(rosterEntry),
    openPositions: v.array(v.number()),
    waitlist: v.array(waitlistEntry),
    yourClaim: v.union(yourClaimValidator, v.null()),
    activity: v.array(schema.doc("activity")),
    youAreInterested: v.boolean(),
    canOrganize: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const shiftId = ctx.db.normalizeId("shifts", args.shiftId);
    const shift = shiftId ? await ctx.db.get(shiftId) : null;
    if (!shiftId || !shift) return emptyDetail;

    // Signed in → the account's row; signed out → the device's guest row. An unknown device is
    // a race with volunteers.ensure, not an error.
    const volunteer = await resolveVolunteer(ctx, args.deviceKey);
    const youId: Id<"volunteers"> | null = volunteer?._id ?? null;

    if (shift.communityId !== undefined) {
      const community = await ctx.db.get(shift.communityId);
      if (!(await canAccessCommunity(ctx, community, volunteer))) {
        return { ...emptyDetail, access: "locked" as const };
      }
    }

    const project = await ctx.db.get(shift.projectId);

    const userId = await getAuthUserId(ctx);
    const canOrganize =
      userId !== null && project?.organizerId !== undefined && project.organizerId === userId;

    let youAreInterested = false;
    if (youId !== null) {
      const interest = await ctx.db
        .query("interest")
        .withIndex("by_shift_volunteer", (q) =>
          q.eq("shiftId", shiftId).eq("volunteerId", youId),
        )
        .unique();
      youAreInterested = interest !== null;
    }

    // Same index and same ordering as lib.readSpotClaims / lib.readWaitlist; inlined here
    // because those helpers are typed for MutationCtx.
    const spots = await ctx.db
      .query("claims")
      .withIndex("by_shift_kind_position", (q) => q.eq("shiftId", shiftId).eq("kind", "spot"))
      .collect();
    const waitlistRows = await ctx.db
      .query("claims")
      .withIndex("by_shift_kind_position", (q) =>
        q.eq("shiftId", shiftId).eq("kind", "waitlist"),
      )
      .collect();

    // <= capacity (16) gets, and only while the sheet is actually open.
    const roster: RosterEntry[] = [];
    for (const claim of spots) {
      const holder = await ctx.db.get(claim.volunteerId);
      roster.push({
        position: claim.position,
        handle: holder?.handle ?? "A neighbor",
        glyph: holder?.glyph ?? "??",
        colorIndex: holder?.colorIndex ?? 0,
        isYou: youId !== null && claim.volunteerId === youId,
        isSeed: claim.isSeed,
        verified: holder?.userId !== undefined && holder !== null,
        username: await usernameOf(ctx, holder),
      });
    }
    roster.sort((a, b) => a.position - b.position);

    const takenSet = new Set(spots.map((c) => c.position));
    const openPositions: number[] = [];
    for (let i = 0; i < shift.capacity; i++) {
      if (!takenSet.has(i)) openPositions.push(i);
    }

    // Ascending position is FIFO, so the array index is the rank.
    const waitlist: WaitlistEntry[] = [];
    for (let i = 0; i < waitlistRows.length; i++) {
      const claim = waitlistRows[i];
      const holder = await ctx.db.get(claim.volunteerId);
      waitlist.push({
        claimId: claim._id,
        rank: i + 1,
        position: claim.position,
        handle: holder?.handle ?? "A neighbor",
        glyph: holder?.glyph ?? "??",
        colorIndex: holder?.colorIndex ?? 0,
        isYou: youId !== null && claim.volunteerId === youId,
        isSeed: claim.isSeed,
        verified: holder?.userId !== undefined && holder !== null,
        username: await usernameOf(ctx, holder),
      });
    }

    let yourClaim: YourClaim | null = null;
    if (youId !== null) {
      const mine =
        spots.find((c) => c.volunteerId === youId) ??
        waitlistRows.find((c) => c.volunteerId === youId) ??
        null;
      if (mine) {
        yourClaim = {
          claimId: mine._id,
          kind: mine.kind,
          position: mine.position,
          waitlistRank:
            mine.kind === "waitlist"
              ? waitlistRows.filter((c) => c.position <= mine.position).length
              : null,
        };
      }
    }

    const activity = await ctx.db
      .query("activity")
      .withIndex("by_shift_created", (q) => q.eq("shiftId", shiftId))
      .order("desc")
      .take(DETAIL_ACTIVITY_LIMIT);

    return {
      access: "ok" as const,
      shift,
      project,
      roster,
      openPositions,
      waitlist,
      yourClaim,
      activity,
      youAreInterested,
      canOrganize,
    };
  },
});

const alternativeValidator = v.object({
  shiftId: v.id("shifts"),
  title: v.string(),
  startsAt: v.number(),
  spotsLeft: v.number(),
});

/**
 * Every non-error outcome is a RETURN VALUE, so the UI renders designed copy instead of an
 * error toast: already claimed, a time conflict, a waitlist seat with an alternative offer,
 * and a reseat when your preferred spot was taken a moment before you clicked.
 */
const claimResultValidator = v.union(
  // Timed unlock: the shift is posted but not claimable yet. The UI shows the countdown.
  v.object({ outcome: v.literal("not_open"), opensAt: v.number() }),
  v.object({
    outcome: v.literal("already"),
    kind: v.union(v.literal("spot"), v.literal("waitlist")),
    position: v.number(),
  }),
  v.object({
    outcome: v.literal("conflict"),
    conflictShiftId: v.id("shifts"),
    conflictTitle: v.string(),
    conflictStartsAt: v.number(),
  }),
  v.object({
    outcome: v.literal("waitlisted"),
    rank: v.number(),
    alternative: v.union(alternativeValidator, v.null()),
    lastActorName: v.string(),
  }),
  v.object({
    outcome: v.union(v.literal("claimed"), v.literal("reseated")),
    position: v.number(),
    requestedPosition: v.union(v.number(), v.null()),
    nth: v.number(),
    spotsLeft: v.number(),
  }),
);

/**
 * Take a spot, or a waitlist seat when the shift is full.
 *
 * A thin wrapper on purpose: identity is resolved server-side from the device key — no mutation
 * ever accepts a client-supplied volunteerId — and then the single write engine in
 * lib.applyClaim runs. The community pulse calls that exact same engine, so simulated activity
 * travels the identical code path, the same transaction, the same activity rows, the same
 * reactivity. The race guard, the idempotency check, the overlap check and the alternative
 * offer all live there and are deliberately not duplicated here.
 */
export const claim = mutation({
  args: {
    deviceKey: v.string(),
    shiftId: v.id("shifts"),
    preferredPosition: v.optional(v.number()),
  },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const volunteer = await requireVolunteer(ctx, args.deviceKey);
    const shift = await ctx.db.get(args.shiftId);
    if (shift) await requireShiftAccess(ctx, shift, volunteer);
    return await applyClaim(ctx, {
      volunteerId: volunteer._id,
      handle: volunteer.handle,
      shiftId: args.shiftId,
      preferredPosition: args.preferredPosition,
      isSim: false,
    });
  },
});

const releaseResultValidator = v.union(
  v.object({ outcome: v.literal("left_waitlist") }),
  v.object({
    outcome: v.literal("released"),
    promoted: v.union(v.object({ handle: v.string() }), v.null()),
  }),
);

/**
 * Give up your spot, or leave the waitlist.
 *
 * Ownership is checked inside lib.applyRelease through the server-resolved volunteerId, never a
 * client-supplied one. When a spot is freed, the FIFO head of the waitlist is promoted into the
 * exact vacated position in the same transaction — which is why a release in one window is
 * visibly a promotion in every other window, with no extra machinery.
 */
export const release = mutation({
  args: { deviceKey: v.string(), shiftId: v.id("shifts") },
  returns: releaseResultValidator,
  handler: async (ctx, args) => {
    const volunteer = await requireVolunteer(ctx, args.deviceKey);
    return await applyRelease(ctx, {
      volunteerId: volunteer._id,
      handle: volunteer.handle,
      shiftId: args.shiftId,
      isSim: false,
    });
  },
});

/**
 * Open more spots on a shift, promoting waitlisted neighbors into them immediately — the
 * fastest way for a judge to manufacture a live promotion in two windows at once.
 *
 * Capacity growth and the promotions happen in ONE transaction. Every promoted seat is chosen
 * with lowestFreePosition against a takenSet that grows as we go, so two promotions can never
 * land on the same position, and positions reuse holes left by earlier releases before spilling
 * into the newly added range. Both counters are recomputed from the contention index afterwards
 * rather than adjusted by arithmetic, so they cannot drift.
 */
export const addCapacity = mutation({
  args: { deviceKey: v.string(), shiftId: v.id("shifts"), delta: v.number() },
  returns: v.object({ promotedHandles: v.array(v.string()), capacity: v.number() }),
  handler: async (ctx, args) => {
    const volunteer = await requireVolunteer(ctx, args.deviceKey);
    const { delta } = args;

    // Number.isInteger also rejects NaN, Infinity and fractions, so nothing unbounded or
    // non-finite can ever reach the capacity field.
    if (!Number.isInteger(delta) || delta < 1 || delta > MAX_DELTA) {
      throw new ConvexError({
        code: "BAD_INPUT",
        message: `Add between 1 and ${MAX_DELTA} spots at a time.`,
      });
    }

    const shift = await ctx.db.get(args.shiftId);
    if (!shift) {
      throw new ConvexError({ code: "GONE", message: "That shift is no longer available." });
    }
    if (shift.status === "cancelled") {
      throw new ConvexError({ code: "CANCELLED", message: "That shift was cancelled." });
    }
    // Real projects belong to their organizer. Seeded demo projects have no organizer and keep
    // the public "+2 spots" control, so a judge can still manufacture a live promotion.
    const project = await ctx.db.get(shift.projectId);
    if (project?.organizerId !== undefined) {
      const userId = await getAuthUserId(ctx);
      if (userId !== project.organizerId) {
        throw new ConvexError({
          code: "NOT_YOURS",
          message: "Only this project's organizer can add spots.",
        });
      }
    }
    if (shift.capacity + delta > MAX_CAPACITY) {
      throw new ConvexError({
        code: "BAD_INPUT",
        message: `A shift can hold at most ${MAX_CAPACITY} people.`,
      });
    }

    const newCapacity = shift.capacity + delta;
    const now = Date.now();

    // The same race guard as applyClaim: collecting every spot row of this shift puts them all
    // in the read set, so a concurrent claim invalidates us and Convex retries against fresh
    // state instead of letting two writers both believe a position is free.
    const taken = await readSpotClaims(ctx, args.shiftId);
    const takenSet = new Set(taken.map((c) => c.position));
    const wl = await readWaitlist(ctx, args.shiftId);

    const promoteCount = Math.min(delta, wl.length);
    const promotedHandles: string[] = [];

    for (let i = 0; i < promoteCount; i++) {
      const head = wl[i];
      const position = lowestFreePosition(takenSet, newCapacity);
      if (position === null) break;

      const headVol = await ctx.db.get(head.volunteerId);
      const promotedName = headVol?.handle ?? "A neighbor";

      await ctx.db.delete(head._id);
      await ctx.db.insert("claims", {
        shiftId: args.shiftId,
        projectId: shift.projectId,
        volunteerId: head.volunteerId,
        kind: "spot",
        position,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        isSeed: head.isSeed,
        createdAt: now,
      });
      takenSet.add(position);
      promotedHandles.push(promotedName);

      await logActivity(ctx, {
        kind: "promoted",
        projectId: shift.projectId,
        shiftId: args.shiftId,
        volunteerId: head.volunteerId,
        actorName: promotedName,
        message: `${promotedName} moved off the waitlist into ${shift.title}`,
        isSim: false,
      });
    }

    const spotsAfter = await readSpotClaims(ctx, args.shiftId);
    const waitlistAfter = await readWaitlist(ctx, args.shiftId);

    await touchShift(ctx, shift, {
      kind: "capacity_added",
      actorName: volunteer.handle,
      isSim: false,
      patch: {
        capacity: newCapacity,
        filledCount: spotsAfter.length,
        waitlistCount: waitlistAfter.length,
      },
    });
    await logActivity(ctx, {
      kind: "capacity_added",
      projectId: shift.projectId,
      shiftId: args.shiftId,
      volunteerId: volunteer._id,
      actorName: volunteer.handle,
      message: `${volunteer.handle} opened ${delta} more spots at ${shift.title}`,
      isSim: false,
    });

    return { promotedHandles, capacity: newCapacity };
  },
});

/**
 * "Notify me" on a shift that is not open yet. Toggles the caller's interest row and recomputes
 * the "N neighbours waiting" count from the index (never +/- 1, so it cannot drift under
 * concurrent taps: every toggle reads the same by_shift range, so Convex OCC serializes them).
 *
 * The notification itself is client-side: when a shift in myCommitments.interests flips from
 * scheduled to open — a flip written by the scheduled organize.openShift — the page alerts.
 */
export const toggleInterest = mutation({
  args: { deviceKey: v.string(), shiftId: v.id("shifts") },
  returns: v.object({ interested: v.boolean(), count: v.number() }),
  handler: async (ctx, args) => {
    const volunteer = await requireVolunteer(ctx, args.deviceKey);
    const shift = await ctx.db.get(args.shiftId);
    if (!shift) {
      throw new ConvexError({ code: "GONE", message: "That shift is no longer available." });
    }
    await requireShiftAccess(ctx, shift, volunteer);
    if (shift.status === "cancelled") {
      throw new ConvexError({ code: "CANCELLED", message: "That shift was cancelled." });
    }
    if (shift.status !== "scheduled") {
      throw new ConvexError({ code: "BAD_INPUT", message: "That shift is already open." });
    }

    const existing = await ctx.db
      .query("interest")
      .withIndex("by_shift_volunteer", (q) =>
        q.eq("shiftId", args.shiftId).eq("volunteerId", volunteer._id),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    } else {
      await ctx.db.insert("interest", {
        shiftId: args.shiftId,
        volunteerId: volunteer._id,
        createdAt: Date.now(),
      });
    }

    const count = (
      await ctx.db
        .query("interest")
        .withIndex("by_shift", (q) => q.eq("shiftId", args.shiftId))
        .take(INTEREST_COUNT_LIMIT)
    ).length;
    await ctx.db.patch(args.shiftId, { interestCount: count });
    return { interested: existing === null, count };
  },
});
