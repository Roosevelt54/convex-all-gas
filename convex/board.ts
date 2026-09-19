import { v } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { changeKindValidator, shiftStatusValidator } from "./schema";
import { OVERLAP_LOOKBACK_MS, WINDOW_BACK_MS, WINDOW_FWD_MS, resolveVolunteer } from "./lib";

/** A shift is "critical" when it has <= 2 spots left AND starts inside this horizon. */
const CRITICAL_HORIZON_MS = 48 * 3600_000;
const CRITICAL_SPOTS_LEFT = 2;

const snapshotProject = v.object({
  _id: v.id("projects"),
  slug: v.string(),
  title: v.string(),
  orgName: v.string(),
  locationLabel: v.string(),
  accentIndex: v.number(),
  tags: v.array(v.string()),
  // Who posted it ("Posted by Mike ✓"); null on seeded demo projects.
  organizerName: v.union(v.string(), v.null()),
  isSeed: v.boolean(),
});

const snapshotShift = v.object({
  _id: v.id("shifts"),
  projectId: v.id("projects"),
  title: v.string(),
  role: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  capacity: v.number(),
  filledCount: v.number(),
  waitlistCount: v.number(),
  status: shiftStatusValidator,
  // Set only on scheduled shifts: when the server will open it for claims.
  opensAt: v.union(v.number(), v.null()),
  interestCount: v.number(),
  isSeed: v.boolean(),
  meetPoint: v.string(),
  skillTag: v.string(),
  lastChangeAt: v.number(),
  lastChangeKind: changeKindValidator,
  lastChangeActorName: v.string(),
  lastChangeIsSim: v.boolean(),
});

type SnapshotProject = {
  _id: Id<"projects">;
  slug: string;
  title: string;
  orgName: string;
  locationLabel: string;
  accentIndex: number;
  tags: string[];
  organizerName: string | null;
  isSeed: boolean;
};

type SnapshotShift = {
  _id: Id<"shifts">;
  projectId: Id<"projects">;
  title: string;
  role: string;
  startsAt: number;
  endsAt: number;
  capacity: number;
  filledCount: number;
  waitlistCount: number;
  status: Doc<"shifts">["status"];
  opensAt: number | null;
  interestCount: number;
  isSeed: boolean;
  meetPoint: string;
  skillTag: string;
  lastChangeAt: number;
  lastChangeKind: Doc<"shifts">["lastChangeKind"];
  lastChangeActorName: string;
  lastChangeIsSim: boolean;
};

/**
 * ONE consistent snapshot: every card AND the header stats come out of a single transaction,
 * so the header can never disagree with the cards and there is no second round trip.
 *
 * Raw timestamps only. Urgency ordering, "starts in 4h" and "2 left" are computed on the
 * client, which re-renders from a ticking clock — a Convex query does not re-run just because
 * wall-clock time passed. Filters are client-side over these <= 60 rows.
 */
export const snapshot = query({
  args: {},
  returns: v.object({
    generatedAt: v.number(),
    projects: v.array(snapshotProject),
    shifts: v.array(snapshotShift),
    stats: v.object({
      shiftCount: v.number(),
      spotsLeftTotal: v.number(),
      criticalCount: v.number(),
      fullCount: v.number(),
      projectCount: v.number(),
      opensSoonCount: v.number(),
    }),
  }),
  handler: async (ctx) => {
    const now = Date.now();

    // Reading Date.now() to build an index RANGE is fine; deriving a boolean from it is not.
    const rows = await ctx.db
      .query("shifts")
      .withIndex("by_start", (q) =>
        q.gte("startsAt", now - WINDOW_BACK_MS).lte("startsAt", now + WINDOW_FWD_MS),
      )
      // Headroom for the ~30 demo shifts plus several organizers at their 20-shift cap.
      .take(100);

    const shifts: SnapshotShift[] = rows.map((s) => ({
      _id: s._id,
      projectId: s.projectId,
      title: s.title,
      role: s.role,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      capacity: s.capacity,
      filledCount: s.filledCount,
      waitlistCount: s.waitlistCount,
      status: s.status,
      opensAt: s.status === "scheduled" ? (s.opensAt ?? null) : null,
      interestCount: s.interestCount ?? 0,
      isSeed: s.isSeed,
      meetPoint: s.meetPoint,
      skillTag: s.skillTag,
      lastChangeAt: s.lastChangeAt,
      lastChangeKind: s.lastChangeKind,
      lastChangeActorName: s.lastChangeActorName,
      lastChangeIsSim: s.lastChangeIsSim,
    }));

    // <= 6 gets: one per distinct project on the board.
    const projectIds: Id<"projects">[] = [];
    const seen = new Set<string>();
    for (const s of rows) {
      if (seen.has(s.projectId)) continue;
      seen.add(s.projectId);
      projectIds.push(s.projectId);
    }
    const projects: SnapshotProject[] = [];
    for (const id of projectIds) {
      const p = await ctx.db.get(id);
      if (!p) continue; // a query must never throw on a missing row during first paint
      projects.push({
        _id: p._id,
        slug: p.slug,
        title: p.title,
        orgName: p.orgName,
        locationLabel: p.locationLabel,
        accentIndex: p.accentIndex,
        tags: p.tags,
        organizerName: p.organizerName ?? null,
        isSeed: p.isSeed,
      });
    }

    let spotsLeftTotal = 0;
    let criticalCount = 0;
    let fullCount = 0;
    let opensSoonCount = 0;
    for (const s of shifts) {
      if (s.status === "scheduled") opensSoonCount += 1;
      if (s.status !== "open") continue;
      const left = Math.max(0, s.capacity - s.filledCount);
      spotsLeftTotal += left;
      if (left === 0) fullCount += 1;
      if (left <= CRITICAL_SPOTS_LEFT && s.startsAt <= now + CRITICAL_HORIZON_MS) {
        criticalCount += 1;
      }
    }

    return {
      generatedAt: now,
      projects,
      shifts,
      stats: {
        shiftCount: shifts.length,
        spotsLeftTotal,
        criticalCount,
        fullCount,
        projectCount: projects.length,
        opensSoonCount,
      },
    };
  },
});

const commitmentRow = v.object({
  claimId: v.id("claims"),
  shiftId: v.id("shifts"),
  projectId: v.id("projects"),
  kind: v.union(v.literal("spot"), v.literal("waitlist")),
  position: v.number(),
  waitlistRank: v.optional(v.number()),
  shiftTitle: v.string(),
  projectTitle: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  meetPoint: v.string(),
  capacity: v.number(),
  filledCount: v.number(),
  overlapsWithClaimId: v.optional(v.string()),
});

type CommitmentRow = {
  claimId: Id<"claims">;
  shiftId: Id<"shifts">;
  projectId: Id<"projects">;
  kind: Doc<"claims">["kind"];
  position: number;
  waitlistRank?: number;
  shiftTitle: string;
  projectTitle: string;
  startsAt: number;
  endsAt: number;
  meetPoint: string;
  capacity: number;
  filledCount: number;
  overlapsWithClaimId?: string;
};

/**
 * "You" state for the cards and the You popover. Kept separate from `snapshot` so it costs one
 * small subscription instead of widening the board read.
 *
 * Never throws: an unknown deviceKey is a first-paint race with volunteers.ensure, not an error.
 */
export const myCommitments = query({
  args: { deviceKey: v.string() },
  returns: v.object({
    volunteer: v.union(
      v.object({
        handle: v.string(),
        glyph: v.string(),
        colorIndex: v.number(),
        verified: v.boolean(),
      }),
      v.null(),
    ),
    claims: v.array(commitmentRow),
    // Shifts this person tapped "Notify me" on. The page alerts when one flips to open.
    interests: v.array(v.id("shifts")),
  }),
  handler: async (ctx, args) => {
    // Signed in → the account's row; signed out → the device's guest row (never an
    // account-owned one).
    const volunteer = await resolveVolunteer(ctx, args.deviceKey);
    if (!volunteer) {
      return { volunteer: null, claims: [] as CommitmentRow[], interests: [] as Id<"shifts">[] };
    }
    const interests = (
      await ctx.db
        .query("interest")
        .withIndex("by_volunteer", (q) => q.eq("volunteerId", volunteer._id))
        // Newest first: old rows for shifts that already opened must never crowd out a fresh tap.
        .order("desc")
        .take(50)
    ).map((i) => i.shiftId);

    const now = Date.now();
    const claims = await ctx.db
      .query("claims")
      .withIndex("by_volunteer_starts", (q) =>
        q.eq("volunteerId", volunteer._id).gte("startsAt", now - OVERLAP_LOOKBACK_MS),
      )
      .take(30);

    const projectCache = new Map<string, Doc<"projects"> | null>();
    // One waitlist read per shift you are actually waitlisted on.
    const waitlistCache = new Map<string, Doc<"claims">[]>();

    const rows: CommitmentRow[] = [];
    for (const claim of claims) {
      const shift = await ctx.db.get(claim.shiftId);
      if (!shift) continue;

      let project = projectCache.get(claim.projectId);
      if (project === undefined) {
        project = await ctx.db.get(claim.projectId);
        projectCache.set(claim.projectId, project);
      }

      let waitlistRank: number | undefined = undefined;
      if (claim.kind === "waitlist") {
        let wl = waitlistCache.get(claim.shiftId);
        if (wl === undefined) {
          wl = await ctx.db
            .query("claims")
            .withIndex("by_shift_kind_position", (q) =>
              q.eq("shiftId", claim.shiftId).eq("kind", "waitlist"),
            )
            .collect();
          waitlistCache.set(claim.shiftId, wl);
        }
        // Live rank: ascending position is FIFO, so your rank is the number of rows at or
        // ahead of your own position. Stays correct after removals from the middle.
        waitlistRank = wl.filter((c) => c.position <= claim.position).length;
      }

      rows.push({
        claimId: claim._id,
        shiftId: claim.shiftId,
        projectId: claim.projectId,
        kind: claim.kind,
        position: claim.position,
        ...(waitlistRank === undefined ? {} : { waitlistRank }),
        shiftTitle: shift.title,
        projectTitle: project?.title ?? "A project",
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        meetPoint: shift.meetPoint,
        capacity: shift.capacity,
        filledCount: shift.filledCount,
      });
    }

    // Overlap warnings for the You popover. Only committed spots can actually collide — being
    // on a waitlist commits you to nothing.
    const spots = claims.filter((c) => c.kind === "spot");
    for (const row of rows) {
      if (row.kind !== "spot") continue;
      const clash = spots.find(
        (o) => o._id !== row.claimId && o.endsAt > row.startsAt && o.startsAt < row.endsAt,
      );
      if (clash) row.overlapsWithClaimId = clash._id;
    }

    return {
      volunteer: {
        handle: volunteer.handle,
        glyph: volunteer.glyph,
        colorIndex: volunteer.colorIndex,
        verified: volunteer.userId !== undefined,
      },
      claims: rows,
      interests,
    };
  },
});
