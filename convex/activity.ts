import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import schema from "./schema";

const activityRow = schema.doc("activity");

/**
 * The Live feed. Messages are rendered server-side at write time, so the ticker is one indexed
 * read with zero joins. Rows come back verbatim, including the raw createdAt — the client turns
 * that into "26s ago" on its own 30s clock rather than the query deriving anything from now().
 */
export const recent = query({
  args: {},
  returns: v.array(activityRow),
  handler: async (ctx) => {
    return await ctx.db.query("activity").withIndex("by_created").order("desc").take(30);
  },
});

/** The "See all activity" drawer via usePaginatedQuery, so the Live ticker stays bounded. */
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(activityRow),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("activity")
      .withIndex("by_created")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
