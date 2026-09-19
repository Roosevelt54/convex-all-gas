import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { shiftStatusValidator } from "./schema";
import {
  WINDOW_BACK_MS,
  WINDOW_FWD_MS,
  cancelOpenJob,
  hashString,
  logActivity,
  openScheduledShift,
  scheduleOpen,
  touchShift,
} from "./lib";

const MAX_PROJECTS_PER_ORGANIZER = 10;
/**
 * Upcoming shifts one organizer may have at once, across all their projects. The board reads a
 * bounded window of shifts, so without a cap a single freshly signed-up account could post
 * enough shifts to push every other organizer's (and the demo's) shifts off it.
 */
const MAX_UPCOMING_SHIFTS_PER_ORGANIZER = 20;
const MAX_SHIFT_HOURS = 12;
const MIN_OPEN_LEAD_MS = 60_000;
const ACCENT_COUNT = 6;

/* ------------------------------------------------------------------ helpers -- */

function bad(message: string): never {
  throw new ConvexError({ code: "BAD_INPUT", message });
}

function text(value: string, label: string, min: number, max: number): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < min || cleaned.length > max) {
    bad(
      min === 0
        ? `${label} can be at most ${max} characters.`
        : `${label} needs ${min}–${max} characters.`,
    );
  }
  return cleaned;
}

function finiteTime(value: number, label: string): number {
  if (!Number.isFinite(value)) bad(`${label} is not a valid time.`);
  return value;
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length > 0 ? base : "project";
}

async function requireAccount(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NO_ACCOUNT", message: "Sign in to organize projects." });
  }
  return userId;
}

/** The organizer's public name: their chosen board handle, else their account display name. */
async function organizerDisplayName(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const volunteer = await ctx.db
    .query("volunteers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (volunteer) return volunteer.handle;
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? "Organizer";
}

/** Loads the shift and its project and proves the caller organizes it. */
async function requireOrganizedShift(
  ctx: MutationCtx,
  shiftId: Id<"shifts">,
): Promise<{ shift: Doc<"shifts">; organizerName: string }> {
  const userId = await requireAccount(ctx);
  const shift = await ctx.db.get(shiftId);
  if (!shift) {
    throw new ConvexError({ code: "GONE", message: "That shift is no longer available." });
  }
  const project = await ctx.db.get(shift.projectId);
  if (!project || project.organizerId !== userId) {
    throw new ConvexError({
      code: "NOT_YOURS",
      message: "Only this project's organizer can do that.",
    });
  }
  return { shift, organizerName: await organizerDisplayName(ctx, userId) };
}

/* ---------------------------------------------------------------- mutations -- */

/**
 * INTERNAL. Fired by ctx.scheduler.runAt at the shift's opensAt. The status write is what makes
 * every open screen unlock at the same instant — no client clock decides anything.
 * Idempotent: a cancelled or already-open shift is left alone, so a stale job is harmless.
 */
export const openShift = internalMutation({
  args: { shiftId: v.id("shifts") },
  returns: v.null(),
  handler: async (ctx, { shiftId }) => {
    await openScheduledShift(ctx, shiftId);
    return null;
  },
});

export const createProject = mutation({
  args: {
    title: v.string(),
    summary: v.string(),
    orgName: v.string(),
    locationLabel: v.string(),
    tags: v.array(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const userId = await requireAccount(ctx);

    const title = text(args.title, "Project title", 3, 60);
    const summary = text(args.summary, "Summary", 0, 280);
    const orgName = text(args.orgName, "Organization", 1, 60);
    const locationLabel = text(args.locationLabel, "Location", 1, 80);
    if (args.tags.length > 5) bad("Use at most 5 tags.");
    const tags = args.tags.map((t) => text(t, "Each tag", 1, 20).toLowerCase());

    const existing = await ctx.db
      .query("projects")
      .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
      .take(MAX_PROJECTS_PER_ORGANIZER);
    if (existing.length >= MAX_PROJECTS_PER_ORGANIZER) {
      bad(`You can organize up to ${MAX_PROJECTS_PER_ORGANIZER} projects.`);
    }

    const now = Date.now();
    const base = slugify(title);
    let slug = `${base}-${hashString(`${userId}:${now}`).toString(36).slice(0, 5)}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await ctx.db
        .query("projects")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (!clash) break;
      slug = `${slug}-${hashString(`${slug}:${attempt}`).toString(36).slice(0, 3)}`;
    }

    return await ctx.db.insert("projects", {
      slug,
      title,
      summary,
      orgName,
      locationLabel,
      accentIndex: hashString(slug) % ACCENT_COUNT,
      tags,
      isSeed: false,
      createdAt: now,
      organizerId: userId,
      organizerName: await organizerDisplayName(ctx, userId),
    });
  },
});

export const createShift = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    role: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    capacity: v.number(),
    meetPoint: v.string(),
    bring: v.array(v.string()),
    skillTag: v.string(),
    opensAt: v.optional(v.number()),
  },
  returns: v.id("shifts"),
  handler: async (ctx, args) => {
    const userId = await requireAccount(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError({ code: "GONE", message: "That project no longer exists." });
    }
    if (project.organizerId !== userId) {
      throw new ConvexError({
        code: "NOT_YOURS",
        message: "Only this project's organizer can post shifts.",
      });
    }

    const now = Date.now();
    const title = text(args.title, "Shift title", 3, 60);
    const role = text(args.role, "Role", 1, 30);
    const meetPoint = text(args.meetPoint, "Meet point", 1, 120);
    if (args.bring.length > 8) bad("List at most 8 things to bring.");
    const bring = args.bring.map((b) => text(b, "Each item to bring", 1, 40));
    const skillTag = args.skillTag.trim().toLowerCase();
    if (!/^[a-z-]{1,16}$/.test(skillTag)) {
      bad("Skill tags are 1–16 letters or dashes, no spaces.");
    }

    if (!Number.isInteger(args.capacity) || args.capacity < 1 || args.capacity > 24) {
      bad("Capacity must be a whole number from 1 to 24.");
    }
    const startsAt = finiteTime(args.startsAt, "Start");
    const endsAt = finiteTime(args.endsAt, "End");
    // The board shows 7 days ahead, so a shift posted further out would be invisible.
    if (startsAt < now || startsAt > now + WINDOW_FWD_MS) {
      bad("Shifts must start between now and 7 days from now.");
    }
    if (endsAt <= startsAt) bad("A shift has to end after it starts.");
    if (endsAt - startsAt > MAX_SHIFT_HOURS * 3600_000) {
      bad(`Shifts can be at most ${MAX_SHIFT_HOURS} hours long.`);
    }

    let opensAt: number | undefined;
    if (args.opensAt !== undefined) {
      opensAt = finiteTime(args.opensAt, "Opening time");
      if (opensAt < now + MIN_OPEN_LEAD_MS || opensAt >= startsAt) {
        bad("Opening time must be in the future and before the shift starts.");
      }
    }

    const myProjects = await ctx.db
      .query("projects")
      .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
      .take(MAX_PROJECTS_PER_ORGANIZER);
    let upcoming = 0;
    for (const p of myProjects) {
      const rows = await ctx.db
        .query("shifts")
        .withIndex("by_project_start", (q) =>
          q.eq("projectId", p._id).gte("startsAt", now - WINDOW_BACK_MS),
        )
        .take(MAX_UPCOMING_SHIFTS_PER_ORGANIZER + 1);
      upcoming += rows.filter((s) => s.status !== "cancelled").length;
    }
    if (upcoming >= MAX_UPCOMING_SHIFTS_PER_ORGANIZER) {
      bad(`You can have up to ${MAX_UPCOMING_SHIFTS_PER_ORGANIZER} upcoming shifts at once.`);
    }

    const organizerName = await organizerDisplayName(ctx, userId);
    const shiftId = await ctx.db.insert("shifts", {
      projectId: project._id,
      title,
      role,
      startsAt,
      endsAt,
      capacity: args.capacity,
      filledCount: 0,
      waitlistCount: 0,
      waitlistSeq: 0,
      status: opensAt === undefined ? "open" : "scheduled",
      ...(opensAt === undefined ? {} : { opensAt }),
      interestCount: 0,
      meetPoint,
      bring,
      skillTag,
      lastChangeAt: now,
      lastChangeKind: "posted",
      lastChangeActorName: organizerName,
      lastChangeIsSim: false,
      lastHumanTouchAt: now,
      isSeed: false,
    });

    if (opensAt !== undefined) {
      const openJobId = await scheduleOpen(ctx, shiftId, opensAt);
      await ctx.db.patch(shiftId, { openJobId });
    }

    await logActivity(ctx, {
      kind: "posted",
      projectId: project._id,
      shiftId,
      actorName: organizerName,
      message: `${organizerName} posted ${title} (${args.capacity} ${
        args.capacity === 1 ? "spot" : "spots"
      })`,
      isSim: false,
    });
    return shiftId;
  },
});

export const cancelShift = mutation({
  args: { shiftId: v.id("shifts") },
  returns: v.null(),
  handler: async (ctx, { shiftId }) => {
    const { shift, organizerName } = await requireOrganizedShift(ctx, shiftId);
    if (shift.status === "cancelled") return null;
    // Cancel the pending open job first, so a stale job can never re-open a cancelled shift.
    await cancelOpenJob(ctx, shift);
    await touchShift(ctx, shift, {
      kind: "cancelled",
      actorName: organizerName,
      isSim: false,
      patch: { status: "cancelled", openJobId: undefined },
    });
    await logActivity(ctx, {
      kind: "cancelled",
      projectId: shift.projectId,
      shiftId,
      actorName: organizerName,
      message: `${organizerName} cancelled ${shift.title}`,
      isSim: false,
    });
    return null;
  },
});

export const openNow = mutation({
  args: { shiftId: v.id("shifts") },
  returns: v.null(),
  handler: async (ctx, { shiftId }) => {
    const { shift } = await requireOrganizedShift(ctx, shiftId);
    if (shift.status !== "scheduled") bad("That shift is already open.");
    await cancelOpenJob(ctx, shift);
    await openScheduledShift(ctx, shiftId);
    return null;
  },
});

/* ------------------------------------------------------------------- query -- */

const personRow = v.object({ position: v.number(), handle: v.string(), verified: v.boolean() });
const waitRow = v.object({ rank: v.number(), handle: v.string(), verified: v.boolean() });

const organizedShift = v.object({
  _id: v.id("shifts"),
  title: v.string(),
  role: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  capacity: v.number(),
  filledCount: v.number(),
  waitlistCount: v.number(),
  status: shiftStatusValidator,
  opensAt: v.union(v.number(), v.null()),
  interestCount: v.number(),
  roster: v.array(personRow),
  waitlist: v.array(waitRow),
});

/**
 * The organizer's own projects and upcoming shifts, with who took each spot — the "was it Jerry
 * or Mike?" answer. Signed-out callers and people who organize nothing get [] (never an error).
 */
export const myProjects = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("projects"),
      title: v.string(),
      summary: v.string(),
      orgName: v.string(),
      locationLabel: v.string(),
      accentIndex: v.number(),
      tags: v.array(v.string()),
      shifts: v.array(organizedShift),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const now = Date.now();
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
      .take(MAX_PROJECTS_PER_ORGANIZER);

    const people = new Map<Id<"volunteers">, Doc<"volunteers"> | null>();
    const person = async (id: Id<"volunteers">) => {
      if (!people.has(id)) people.set(id, await ctx.db.get(id));
      const p = people.get(id) ?? null;
      return { handle: p?.handle ?? "A neighbour", verified: p !== null && p.userId !== undefined };
    };

    const out = [];
    for (const project of projects) {
      const shifts = await ctx.db
        .query("shifts")
        .withIndex("by_project_start", (q) =>
          q
            .eq("projectId", project._id)
            .gte("startsAt", now - WINDOW_BACK_MS)
            .lte("startsAt", now + WINDOW_FWD_MS),
        )
        .take(40);

      const rows = [];
      for (const s of shifts) {
        const spots = await ctx.db
          .query("claims")
          .withIndex("by_shift_kind_position", (q) => q.eq("shiftId", s._id).eq("kind", "spot"))
          .take(24);
        const waiting = await ctx.db
          .query("claims")
          .withIndex("by_shift_kind_position", (q) =>
            q.eq("shiftId", s._id).eq("kind", "waitlist"),
          )
          .take(50);
        const roster = [];
        for (const c of spots) roster.push({ position: c.position, ...(await person(c.volunteerId)) });
        const waitlist = [];
        for (let i = 0; i < waiting.length; i++) {
          waitlist.push({ rank: i + 1, ...(await person(waiting[i].volunteerId)) });
        }
        rows.push({
          _id: s._id,
          title: s.title,
          role: s.role,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          capacity: s.capacity,
          filledCount: s.filledCount,
          waitlistCount: s.waitlistCount,
          status: s.status,
          opensAt: s.opensAt ?? null,
          interestCount: s.interestCount ?? 0,
          roster,
          waitlist,
        });
      }

      out.push({
        _id: project._id,
        title: project.title,
        summary: project.summary,
        orgName: project.orgName,
        locationLabel: project.locationLabel,
        accentIndex: project.accentIndex,
        tags: project.tags,
        shifts: rows,
      });
    }
    return out;
  },
});
