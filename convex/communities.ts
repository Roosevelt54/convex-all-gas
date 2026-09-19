import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { demoCommunity, requireVolunteer, resolveCommunity, resolveVolunteer } from "./lib";

const MAX_COMMUNITIES_PER_ORGANIZER = 5;
const MEMBER_COUNT_LIMIT = 1000;

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

/** 16 unguessable characters from the platform CSPRNG. The code IS the invitation. */
function newJoinCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function organizerName(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<string> {
  const volunteer = await ctx.db
    .query("volunteers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (volunteer) return volunteer.handle;
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? "Organizer";
}

/**
 * An organizer creates their community's own space and gets its invite link. Nobody else sees
 * its shifts, feed or wall until they open that link.
 */
export const create = mutation({
  args: { name: v.string(), description: v.string() },
  returns: v.object({ communityId: v.id("communities"), joinCode: v.string() }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NO_ACCOUNT", message: "Sign in to create a community." });
    }
    const name = text(args.name, "Community name", 3, 60);
    const description = text(args.description, "Description", 0, 280);
    const existing = await ctx.db
      .query("communities")
      .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
      .take(MAX_COMMUNITIES_PER_ORGANIZER);
    if (existing.length >= MAX_COMMUNITIES_PER_ORGANIZER) {
      bad(`You can organize up to ${MAX_COMMUNITIES_PER_ORGANIZER} communities.`);
    }

    let joinCode = newJoinCode();
    while (
      await ctx.db
        .query("communities")
        .withIndex("by_join_code", (q) => q.eq("joinCode", joinCode))
        .unique()
    ) {
      joinCode = newJoinCode();
    }

    const communityId = await ctx.db.insert("communities", {
      name,
      description,
      joinCode,
      isPublic: false,
      isSeed: false,
      organizerId: userId,
      organizerName: await organizerName(ctx, userId),
      createdAt: Date.now(),
    });
    return { communityId, joinCode };
  },
});

/**
 * Opening an invite link. Idempotent: opening it twice is a no-op. Works for guests (no account
 * needed); a guest's memberships follow them into an account when they sign up.
 */
export const join = mutation({
  args: { deviceKey: v.string(), joinCode: v.string() },
  returns: v.object({ communityId: v.id("communities"), name: v.string() }),
  handler: async (ctx, args) => {
    const volunteer = await requireVolunteer(ctx, args.deviceKey);
    const code = args.joinCode.trim().toLowerCase();
    if (!/^[a-z0-9]{6,32}$/.test(code)) bad("That invite link isn't valid.");
    const community = await ctx.db
      .query("communities")
      .withIndex("by_join_code", (q) => q.eq("joinCode", code))
      .unique();
    if (!community) bad("That invite link isn't valid anymore. Ask the organizer for a new one.");

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_community_volunteer", (q) =>
        q.eq("communityId", community._id).eq("volunteerId", volunteer._id),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("memberships", {
        communityId: community._id,
        volunteerId: volunteer._id,
        joinedAt: Date.now(),
      });
    }
    return { communityId: community._id, name: community.name };
  },
});

const communityView = v.object({
  _id: v.id("communities"),
  name: v.string(),
  description: v.string(),
  isPublic: v.boolean(),
  isMember: v.boolean(),
  isOrganizer: v.boolean(),
  canView: v.boolean(),
  organizerName: v.union(v.string(), v.null()),
  // The invite code is returned ONLY to the organizer.
  joinCode: v.union(v.string(), v.null()),
  memberCount: v.number(),
});

async function viewOf(
  ctx: QueryCtx,
  community: Doc<"communities">,
  volunteer: Doc<"volunteers"> | null,
) {
  const userId = await getAuthUserId(ctx);
  const isOrganizer = userId !== null && community.organizerId === userId;
  let isMember = false;
  if (volunteer) {
    isMember =
      (await ctx.db
        .query("memberships")
        .withIndex("by_community_volunteer", (q) =>
          q.eq("communityId", community._id).eq("volunteerId", volunteer._id),
        )
        .unique()) !== null;
  }
  const memberCount = (
    await ctx.db
      .query("memberships")
      .withIndex("by_community", (q) => q.eq("communityId", community._id))
      .take(MEMBER_COUNT_LIMIT)
  ).length;
  return {
    _id: community._id,
    name: community.name,
    description: community.description,
    isPublic: community.isPublic,
    isMember,
    isOrganizer,
    canView: community.isPublic || isOrganizer || isMember,
    organizerName: community.organizerName ?? null,
    joinCode: isOrganizer ? community.joinCode : null,
    memberCount,
  };
}

/**
 * One community as the caller sees it; with no communityId, the public demo community.
 * A private community's name is visible (so an outsider learns whose space it is) but canView is
 * false, and every shift/feed read refuses them. A malformed id returns null, never throws.
 */
export const get = query({
  args: { communityId: v.optional(v.string()), deviceKey: v.string() },
  returns: v.union(communityView, v.null()),
  handler: async (ctx, args) => {
    const community = await resolveCommunity(ctx, args.communityId);
    if (!community) return null;
    return await viewOf(ctx, community, await resolveVolunteer(ctx, args.deviceKey));
  },
});

/** The community switcher: the public demo, then everything you organize or joined. */
export const mine = query({
  args: { deviceKey: v.string() },
  returns: v.array(communityView),
  handler: async (ctx, args) => {
    const volunteer = await resolveVolunteer(ctx, args.deviceKey);
    const userId = await getAuthUserId(ctx);
    const seen = new Set<string>();
    const rows: Doc<"communities">[] = [];
    const add = (c: Doc<"communities"> | null) => {
      if (c && !seen.has(c._id)) {
        seen.add(c._id);
        rows.push(c);
      }
    };

    add(await demoCommunity(ctx));
    if (userId !== null) {
      for (const c of await ctx.db
        .query("communities")
        .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
        .take(MAX_COMMUNITIES_PER_ORGANIZER)) {
        add(c);
      }
    }
    if (volunteer) {
      for (const m of await ctx.db
        .query("memberships")
        .withIndex("by_volunteer", (q) => q.eq("volunteerId", volunteer._id))
        .take(50)) {
        add(await ctx.db.get(m.communityId));
      }
    }

    const out = [];
    for (const c of rows) out.push(await viewOf(ctx, c, volunteer));
    return out;
  },
});
