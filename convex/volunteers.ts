import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { generateHandle, hashString, initials, requireVolunteer, sanitizeHandle } from "./lib";

const DEVICE_KEY_MIN = 8;
const DEVICE_KEY_MAX = 64;
const COLOR_COUNT = 8;

function requireDeviceKey(deviceKey: string): string {
  if (deviceKey.length < DEVICE_KEY_MIN || deviceKey.length > DEVICE_KEY_MAX) {
    throw new ConvexError({
      code: "BAD_INPUT",
      message: "That device key doesn't look right — reload the page.",
    });
  }
  return deviceKey;
}

/**
 * Upserts the device-scoped pseudonymous neighbor and returns them ready to render: no provider,
 * no password, no gate.
 *
 * It also schedules internal.seed.ensure and internal.sim.kick at runAfter(0). That is what makes
 * a cold, wiped, or overnight-idle deployment heal and wake the instant someone opens the app, so
 * a missed deploy step can never present an empty board.
 */
export const ensure = mutation({
  args: { deviceKey: v.string() },
  returns: v.object({
    _id: v.id("volunteers"),
    handle: v.string(),
    glyph: v.string(),
    colorIndex: v.number(),
  }),
  handler: async (ctx, args) => {
    const deviceKey = requireDeviceKey(args.deviceKey);
    const now = Date.now();

    const existing = await ctx.db
      .query("volunteers")
      .withIndex("by_device_key", (q) => q.eq("deviceKey", deviceKey))
      .unique();

    let result: {
      _id: Id<"volunteers">;
      handle: string;
      glyph: string;
      colorIndex: number;
    };

    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
      result = {
        _id: existing._id,
        handle: existing.handle,
        glyph: existing.glyph,
        colorIndex: existing.colorIndex,
      };
    } else {
      const handle = generateHandle(deviceKey);
      const glyph = initials(handle);
      const colorIndex = hashString(deviceKey) % COLOR_COUNT;
      const volunteerId = await ctx.db.insert("volunteers", {
        deviceKey,
        handle,
        glyph,
        colorIndex,
        isSeed: false,
        createdAt: now,
        lastSeenAt: now,
        writeCount: 0,
        writeWindowStart: now,
      });
      result = { _id: volunteerId, handle, glyph, colorIndex };
    }

    await ctx.scheduler.runAfter(0, internal.seed.ensure, {});
    await ctx.scheduler.runAfter(0, internal.sim.kick, {});

    return result;
  },
});

/**
 * Inline handle edit. sanitizeHandle trims, collapses whitespace, strips control characters so a
 * newline can never reach the UI, and throws BAD_INPUT on empty or >24 chars.
 *
 * Historical activity rows keep their snapshot names by design — the feed records what was true
 * when it happened instead of rewriting itself.
 */
export const rename = mutation({
  args: { deviceKey: v.string(), handle: v.string() },
  returns: v.object({ handle: v.string(), glyph: v.string() }),
  handler: async (ctx, args) => {
    const volunteer = await requireVolunteer(ctx, args.deviceKey);
    const handle = sanitizeHandle(args.handle);
    const glyph = initials(handle);
    await ctx.db.patch(volunteer._id, { handle, glyph });
    return { handle, glyph };
  },
});
