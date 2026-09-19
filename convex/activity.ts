import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import schema from "./schema";
import { canAccessCommunity, resolveCommunity, resolveVolunteer } from "./lib";

const activityRow = schema.doc("activity");

const scopeArgs = { communityId: v.optional(v.string()), deviceKey: v.optional(v.string()) };

/** The community whose feed the caller may read, or null (unknown, or private and not joined). */
async function readableCommunity(
  ctx: QueryCtx,
  args: { communityId?: string; deviceKey?: string },
) {
  const community = await resolveCommunity(ctx, args.communityId);
  const volunteer = args.deviceKey === undefined ? null : await resolveVolunteer(ctx, args.deviceKey);
  return (await canAccessCommunity(ctx, community, volunteer)) ? community : null;
}

/**
 * The Live feed of ONE community. Messages are rendered server-side at write time, so the ticker
 * is one indexed read with zero joins. The client turns createdAt into "26s ago" on its own clock.
 */
export const recent = query({
  args: scopeArgs,
  returns: v.array(activityRow),
  handler: async (ctx, args) => {
    const community = await readableCommunity(ctx, args);
    if (!community) return [];
    return await ctx.db
      .query("activity")
      .withIndex("by_community_created", (q) => q.eq("communityId", community._id))
      .order("desc")
      .take(30);
  },
});

/** The "See all activity" drawer via usePaginatedQuery, so the Live ticker stays bounded. */
export const page = query({
  args: { ...scopeArgs, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(activityRow),
  handler: async (ctx, args) => {
    const community = await readableCommunity(ctx, args);
    if (!community) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("activity")
      .withIndex("by_community_created", (q) => q.eq("communityId", community._id))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
