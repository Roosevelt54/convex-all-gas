import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
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
  }).index("by_slug", ["slug"]),

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
    status: v.union(v.literal("open"), v.literal("cancelled")),
    meetPoint: v.string(),
    bring: v.array(v.string()),
    skillTag: v.string(),
    // Causal attribution: lets a card say WHY it just changed with zero joins.
    lastChangeAt: v.number(),
    lastChangeKind: v.union(
      v.literal("seeded"),
      v.literal("claimed"),
      v.literal("released"),
      v.literal("promoted"),
      v.literal("waitlisted"),
      v.literal("capacity_added"),
    ),
    lastChangeActorName: v.string(),
    lastChangeIsSim: v.boolean(),
    // Last non-sim write. The pulse must not touch a shift within 90s of this.
    lastHumanTouchAt: v.number(),
    isSeed: v.boolean(),
  })
    .index("by_project_start", ["projectId", "startsAt"])
    .index("by_start", ["startsAt"])
    .index("by_status_start", ["status", "startsAt"]),

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
  }).index("by_device_key", ["deviceKey"]),

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
    .index("by_shift_created", ["shiftId", "createdAt"]),

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
