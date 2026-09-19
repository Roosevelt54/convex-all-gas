import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const shiftStatusValidator = v.union(
  v.literal("open"),
  v.literal("scheduled"),
  v.literal("cancelled"),
);

export const changeKindValidator = v.union(
  v.literal("seeded"),
  v.literal("claimed"),
  v.literal("released"),
  v.literal("promoted"),
  v.literal("waitlisted"),
  v.literal("capacity_added"),
  v.literal("posted"),
  v.literal("opened"),
  v.literal("cancelled"),
);

export default defineSchema({
  ...authTables,

  projects: defineTable({
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    orgName: v.string(),
    locationLabel: v.string(),
    accentIndex: v.number(),
    tags: v.array(v.string()),
    isSeed: v.boolean(),
    createdAt: v.number(),
    // Absent on seeded demo projects, which keep their public demo controls.
    organizerId: v.optional(v.id("users")),
    organizerName: v.optional(v.string()),
  })
    .index("by_slug", ["slug"])
    .index("by_organizer", ["organizerId"]),

  shifts: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    role: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    capacity: v.number(),
    // Denormalized counters. Always recomputed from by_shift_kind_position inside
    // the same transaction, never blind +/- 1, so they cannot drift.
    filledCount: v.number(),
    waitlistCount: v.number(),
    // Monotonic allocator for waitlist positions; never decremented, so FIFO order
    // survives arbitrary removals from the middle of the queue.
    waitlistSeq: v.number(),
    // "scheduled" = posted but not yet claimable; organize.openShift flips it at opensAt.
    status: shiftStatusValidator,
    opensAt: v.optional(v.number()),
    openJobId: v.optional(v.id("_scheduled_functions")),
    // Denormalized "N neighbours waiting", recomputed from interest.by_shift on every toggle.
    interestCount: v.optional(v.number()),
    meetPoint: v.string(),
    bring: v.array(v.string()),
    skillTag: v.string(),
    // Causal attribution: lets a card say WHY it just changed with zero joins.
    lastChangeAt: v.number(),
    lastChangeKind: changeKindValidator,
    lastChangeActorName: v.string(),
    lastChangeIsSim: v.boolean(),
    // Last non-sim write. The pulse must not touch a shift within 90s of this.
    lastHumanTouchAt: v.number(),
    isSeed: v.boolean(),
  })
    .index("by_project_start", ["projectId", "startsAt"])
    .index("by_start", ["startsAt"])
    .index("by_status_start", ["status", "startsAt"])
    // The pulse reads ONLY seeded shifts, so real shifts can never crowd them out of its read.
    .index("by_seed_start", ["isSeed", "startsAt"]),

  claims: defineTable({
    shiftId: v.id("shifts"),
    projectId: v.id("projects"),
    volunteerId: v.id("volunteers"),
    kind: v.union(v.literal("spot"), v.literal("waitlist")),
    // kind "spot": 0..capacity-1, unique per shift.
    // kind "waitlist": value from shifts.waitlistSeq, strictly increasing => FIFO ascending.
    position: v.number(),
    startsAt: v.number(),
    endsAt: v.number(),
    isSeed: v.boolean(),
    createdAt: v.number(),
  })
    // THE contention index: reading this range is the serializable guard, and its
    // ascending order is the FIFO waitlist.
    .index("by_shift_kind_position", ["shiftId", "kind", "position"])
    .index("by_shift_volunteer", ["shiftId", "volunteerId"])
    .index("by_volunteer_starts", ["volunteerId", "startsAt"]),

  volunteers: defineTable({
    deviceKey: v.string(),
    handle: v.string(),
    glyph: v.string(),
    colorIndex: v.number(),
    isSeed: v.boolean(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    writeCount: v.number(),
    writeWindowStart: v.number(),
    // Set when an account owns this row; its deviceKey is then "acct:<userId>" and the row is
    // only reachable through a signed-in session, never through a client device key.
    userId: v.optional(v.id("users")),
    nameChosen: v.optional(v.boolean()),
  })
    .index("by_device_key", ["deviceKey"])
    .index("by_user", ["userId"])
    .index("by_seed", ["isSeed"]),

  // Liveness is STORED, never computed from Date.now() inside a query: Convex queries
  // do not re-run just because wall-clock time passed. presence.sweep WRITES
  // isActive=false; readers filter on the boolean, so "N here now" decays with zero traffic.
  presence: defineTable({
    volunteerId: v.id("volunteers"),
    deviceKey: v.string(),
    scope: v.string(),
    isActive: v.boolean(),
    lastPingAt: v.number(),
    handle: v.string(),
    glyph: v.string(),
    colorIndex: v.number(),
  })
    .index("by_device_scope", ["deviceKey", "scope"])
    .index("by_scope_active", ["scope", "isActive"])
    .index("by_active_ping", ["isActive", "lastPingAt"]),

  activity: defineTable({
    kind: v.union(
      v.literal("claimed"),
      v.literal("released"),
      v.literal("promoted"),
      v.literal("waitlisted"),
      v.literal("reseated"),
      v.literal("filled"),
      v.literal("capacity_added"),
      v.literal("posted"),
      v.literal("opened"),
      v.literal("cancelled"),
    ),
    projectId: v.optional(v.id("projects")),
    shiftId: v.optional(v.id("shifts")),
    volunteerId: v.optional(v.id("volunteers")),
    actorName: v.string(),
    // Fully rendered server-side; the ticker is one indexed read with no joins.
    message: v.string(),
    isSim: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_shift_created", ["shiftId", "createdAt"])
    // Lets the watchdog prune simulated rows only; real organizer history is never pruned.
    .index("by_sim_created", ["isSim", "createdAt"]),

  // "Notify me" taps on scheduled shifts.
  interest: defineTable({
    shiftId: v.id("shifts"),
    volunteerId: v.id("volunteers"),
    createdAt: v.number(),
  })
    .index("by_shift", ["shiftId"])
    .index("by_shift_volunteer", ["shiftId", "volunteerId"])
    .index("by_volunteer", ["volunteerId"]),

  // Exactly one row, key === "main".
  meta: defineTable({
    key: v.string(),
    seedVersion: v.number(),
    pulseEnabled: v.boolean(),
    pulseRunning: v.boolean(),
    // A chain that finds meta.pulseToken !== its own token exits; prevents duplicate
    // chains after a redeploy.
    pulseToken: v.string(),
    lastPulseAt: v.number(),
    lastSeededAt: v.number(),
  }).index("by_key", ["key"]),
});
