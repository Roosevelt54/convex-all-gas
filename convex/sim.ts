import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  applyClaim,
  applyRelease,
  readSpotClaims,
  HUMAN_TOUCH_GRACE_MS,
  WINDOW_BACK_MS,
  WINDOW_FWD_MS,
} from "./lib";

/** A chain that has ticked within this long is demonstrably alive; kick refuses to fork it. */
const CHAIN_ALIVE_MS = 20_000;
/** The watchdog treats a chain quieter than this as dead. */
const CHAIN_STALE_MS = 25_000;
/** Presence rows older than this do not count as "somebody is watching". */
const PRESENCE_WINDOW_MS = 90_000;
/** First hop after a kick: a judge sees motion ~1.5s after their first heartbeat. */
const FIRST_HOP_MS = 1500;
/** 3-9s of jitter, so activity feels organic rather than metronomic. */
const MIN_GAP_MS = 3000;
const JITTER_MS = 6000;

/** Steering band: above this the board is saturating, so the pulse releases. */
const FILL_HIGH = 0.68;
/** Below this the board is draining, so the pulse claims. */
const FILL_LOW = 0.42;
/** Inside the band, claim with this probability. */
const CLAIM_BIAS = 0.7;

/** The pulse never consumes the last two spots — a judge must always have one to take. */
const RESERVED_SPOTS = 2;

/** Bounded scan sizes: the seed writes 24 volunteers and <= 30 shifts. */
const MAX_VOLUNTEER_SCAN = 80;
const MAX_SHIFT_TRIES = 8;
const MAX_VOLUNTEER_TRIES = 6;

/** The ticker is bounded so a long judging day cannot grow the table without limit. */
const ACTIVITY_MAX_ROWS = 300;
const ACTIVITY_PRUNE_BATCH = 50;

async function readMeta(ctx: MutationCtx): Promise<Doc<"meta"> | null> {
  return await ctx.db
    .query("meta")
    .withIndex("by_key", (q) => q.eq("key", "main"))
    .unique();
}

/**
 * THE PRESENCE GATE, in one place. Liveness is a stored boolean plus a stored timestamp,
 * so this costs a single indexed read of at most one row.
 */
async function someoneIsWatching(ctx: MutationCtx, now: number): Promise<boolean> {
  const live = await ctx.db
    .query("presence")
    .withIndex("by_active_ping", (q) =>
      q.eq("isActive", true).gt("lastPingAt", now - PRESENCE_WINDOW_MS),
    )
    .take(1);
  return live.length > 0;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Mints a fresh token and starts a chain. Shared by `kick` and `watchdog` so the watchdog
 * restarts the pulse inside its own transaction instead of paying a scheduler hop.
 */
async function startChain(ctx: MutationCtx, meta: Doc<"meta">, now: number): Promise<void> {
  const token = crypto.randomUUID();
  await ctx.db.patch(meta._id, { pulseToken: token, pulseRunning: true, lastPulseAt: now });
  await ctx.scheduler.runAfter(FIRST_HOP_MS, internal.sim.tick, { token });
}

/**
 * Wakes the community pulse. Called from `volunteers.ensure`, `presence.ping` (throttled)
 * and `meta.setPulse`, so a cold, wiped, or overnight-idle deployment starts moving the
 * instant somebody opens the app.
 */
export const kick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const meta = await readMeta(ctx);
    if (!meta) return null;
    if (!meta.pulseEnabled) return null;

    const now = Date.now();
    // A chain that ticked inside the last 20s is demonstrably alive. Forking a second one
    // would double every write for the rest of the session.
    if (meta.pulseRunning && now - meta.lastPulseAt < CHAIN_ALIVE_MS) return null;

    await startChain(ctx, meta, now);
    return null;
  },
});

/** Picks a seeded volunteer with no claim on this shift and claims through the human engine. */
async function tryClaim(
  ctx: MutationCtx,
  candidates: readonly Doc<"shifts">[],
  seedVolunteers: readonly Doc<"volunteers">[],
): Promise<boolean> {
  if (seedVolunteers.length === 0) return false;

  const claimable = candidates.filter((s) => s.filledCount <= s.capacity - RESERVED_SPOTS);
  for (const shift of shuffled(claimable).slice(0, MAX_SHIFT_TRIES)) {
    for (const person of shuffled(seedVolunteers).slice(0, MAX_VOLUNTEER_TRIES)) {
      const existing = await ctx.db
        .query("claims")
        .withIndex("by_shift_volunteer", (q) =>
          q.eq("shiftId", shift._id).eq("volunteerId", person._id),
        )
        .unique();
      if (existing) continue;

      // The identical engine a human's `shifts.claim` runs: same transaction, same
      // counters, same activity row, same reactivity. Nothing here is mocked.
      await applyClaim(ctx, {
        volunteerId: person._id,
        handle: person.handle,
        shiftId: shift._id,
        preferredPosition: undefined,
        isSim: true,
      });
      return true;
    }
  }
  return false;
}

/** Releases a seeded spot, which may promote a waitlisted neighbour in the same transaction. */
async function tryRelease(
  ctx: MutationCtx,
  candidates: readonly Doc<"shifts">[],
): Promise<boolean> {
  for (const shift of shuffled(candidates).slice(0, MAX_SHIFT_TRIES)) {
    if (shift.filledCount === 0) continue;
    const spots = await readSpotClaims(ctx, shift._id);
    const seeded = spots.filter((c) => c.isSeed);
    if (seeded.length === 0) continue;

    const pick = seeded[Math.floor(Math.random() * seeded.length)];
    const person = await ctx.db.get(pick.volunteerId);
    await applyRelease(ctx, {
      volunteerId: pick.volunteerId,
      handle: person?.handle ?? "A neighbor",
      shiftId: shift._id,
      isSim: true,
    });
    return true;
  }
  return false;
}

/**
 * One beat of the community pulse: at most one real claim or release, then it reschedules
 * itself with jitter. Every exit path that does not reschedule first clears `pulseRunning`,
 * so the watchdog can tell a stopped chain from a running one.
 */
export const tick = internalMutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const meta = await readMeta(ctx);
    if (!meta) return null;

    // TOKEN GUARD. A chain left over from a previous deploy holds a stale token and dies
    // here rather than doubling up with the live chain.
    if (args.token !== meta.pulseToken) return null;

    if (!meta.pulseEnabled) {
      await ctx.db.patch(meta._id, { pulseRunning: false });
      return null;
    }

    const now = Date.now();

    // PRESENCE GATE — this is why the app costs nothing overnight.
    // With no active heartbeat inside 90s the chain stops here and does NOT reschedule, so
    // the pulse performs zero function calls while nobody is looking. It restarts within
    // ~1.5s of the next heartbeat, because `presence.ping` kicks it.
    if (!(await someoneIsWatching(ctx, now))) {
      await ctx.db.patch(meta._id, { pulseRunning: false });
      return null;
    }

    const shifts = await ctx.db
      .query("shifts")
      .withIndex("by_start", (q) =>
        q.gte("startsAt", now - WINDOW_BACK_MS).lte("startsAt", now + WINDOW_FWD_MS),
      )
      .take(60);

    let totalCapacity = 0;
    let totalFilled = 0;
    for (const s of shifts) {
      totalCapacity += s.capacity;
      totalFilled += s.filledCount;
    }
    const globalFill = totalCapacity > 0 ? totalFilled / totalCapacity : 0;

    const candidates = shifts.filter(
      (s) =>
        s.status === "open" &&
        // NEVER FIGHT THE HUMAN: leave alone whatever a person just touched, because that
        // is almost certainly the card they are looking at.
        s.lastHumanTouchAt <= now - HUMAN_TOUCH_GRACE_MS,
    );

    // Steer global fill into the 40-70% band so the board neither saturates nor drains
    // over a long judging session.
    const preferRelease =
      globalFill > FILL_HIGH ? true : globalFill < FILL_LOW ? false : Math.random() >= CLAIM_BIAS;

    const seedVolunteers = (await ctx.db.query("volunteers").take(MAX_VOLUNTEER_SCAN)).filter(
      (person) => person.isSeed,
    );

    // If the preferred action has no candidate, fall back to the other before giving up;
    // a tick that does nothing at all is only for when neither action is possible.
    if (preferRelease) {
      const acted = await tryRelease(ctx, candidates);
      if (!acted) await tryClaim(ctx, candidates, seedVolunteers);
    } else {
      const acted = await tryClaim(ctx, candidates, seedVolunteers);
      if (!acted) await tryRelease(ctx, candidates);
    }

    await ctx.db.patch(meta._id, { lastPulseAt: now, pulseRunning: true });
    await ctx.scheduler.runAfter(
      MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS),
      internal.sim.tick,
      { token: args.token },
    );
    return null;
  },
});

/**
 * 60s cron. Two jobs: the chain can never die permanently while somebody is watching, and
 * the activity ticker stays bounded over a long judging day.
 */
export const watchdog = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const meta = await readMeta(ctx);
    const now = Date.now();

    if (meta && meta.pulseEnabled) {
      const stale = !meta.pulseRunning || now - meta.lastPulseAt > CHAIN_STALE_MS;
      // Restart ONLY when somebody is present, so the watchdog can never revive the pulse
      // against an empty room and undo the overnight saving.
      if (stale && (await someoneIsWatching(ctx, now))) {
        await startChain(ctx, meta, now);
      }
    }

    // Prune the ticker: if the table is past 300 rows, drop the oldest 50.
    const oldest = await ctx.db
      .query("activity")
      .withIndex("by_created")
      .take(ACTIVITY_MAX_ROWS + 1);
    if (oldest.length > ACTIVITY_MAX_ROWS) {
      for (const row of oldest.slice(0, ACTIVITY_PRUNE_BATCH)) {
        await ctx.db.delete(row._id);
      }
    }
    return null;
  },
});
