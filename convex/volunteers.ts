import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  ACCOUNT_KEY_PREFIX,
  COLOR_COUNT,
  assertClientDeviceKey,
  generateHandle,
  hashString,
  initials,
  requireVolunteer,
  resolveVolunteer,
  sanitizeHandle,
} from "./lib";

const selfShape = v.object({
  _id: v.id("volunteers"),
  handle: v.string(),
  glyph: v.string(),
  colorIndex: v.number(),
  nameChosen: v.boolean(),
  verified: v.boolean(),
});

function toSelf(row: Doc<"volunteers">) {
  return {
    _id: row._id,
    handle: row.handle,
    glyph: row.glyph,
    colorIndex: row.colorIndex,
    nameChosen: row.nameChosen === true,
    verified: row.userId !== undefined,
  };
}

async function accountVolunteer(
  ctx: MutationCtx,
  deviceKey: string,
  now: number,
): Promise<Doc<"volunteers">> {
  const userId = (await getAuthUserId(ctx))!;
  const mine = await ctx.db
    .query("volunteers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (mine) {
    await ctx.db.patch(mine._id, { lastSeenAt: now });
    return { ...mine, lastSeenAt: now };
  }

  const user = await ctx.db.get(userId);
  const accountName = user?.name?.trim() || user?.email || "Neighbour";
  const accountKey = `${ACCOUNT_KEY_PREFIX}${userId}`;

  // Link this device's GUEST row, so spots claimed before signing in follow the person into
  // their account. Rewriting its deviceKey frees the device key: after sign-out the same device
  // becomes a brand-new guest instead of silently acting as the account.
  const guest = await ctx.db
    .query("volunteers")
    .withIndex("by_device_key", (q) => q.eq("deviceKey", deviceKey))
    .unique();
  if (guest && guest.userId === undefined && !guest.isSeed) {
    const keepName = guest.nameChosen === true;
    const handle = keepName ? guest.handle : sanitizeHandle(accountName);
    const patch = {
      userId,
      deviceKey: accountKey,
      nameChosen: true,
      handle,
      glyph: keepName ? guest.glyph : initials(handle),
      lastSeenAt: now,
    };
    await ctx.db.patch(guest._id, patch);
    return { ...guest, ...patch };
  }

  const handle = sanitizeHandle(accountName);
  const id = await ctx.db.insert("volunteers", {
    deviceKey: accountKey,
    userId,
    nameChosen: true,
    handle,
    glyph: initials(handle),
    colorIndex: hashString(accountKey) % COLOR_COUNT,
    isSeed: false,
    createdAt: now,
    lastSeenAt: now,
    writeCount: 0,
    writeWindowStart: now,
  });
  return (await ctx.db.get(id))!;
}

async function guestVolunteer(
  ctx: MutationCtx,
  deviceKey: string,
  now: number,
): Promise<Doc<"volunteers">> {
  const existing = await ctx.db
    .query("volunteers")
    .withIndex("by_device_key", (q) => q.eq("deviceKey", deviceKey))
    .unique();
  // An account-owned row is never usable signed out. Linking rewrites its deviceKey, so this is
  // a belt-and-braces check for any account row still carrying a plain device key.
  if (existing && existing.userId === undefined) {
    await ctx.db.patch(existing._id, { lastSeenAt: now });
    return { ...existing, lastSeenAt: now };
  }
  if (existing) {
    // Free the key rather than create a duplicate: by_device_key must stay unique.
    await ctx.db.patch(existing._id, { deviceKey: `${ACCOUNT_KEY_PREFIX}${existing.userId}` });
  }
  const handle = generateHandle(deviceKey);
  const id = await ctx.db.insert("volunteers", {
    deviceKey,
    handle,
    glyph: initials(handle),
    colorIndex: hashString(deviceKey) % COLOR_COUNT,
    isSeed: false,
    nameChosen: false,
    createdAt: now,
    lastSeenAt: now,
    writeCount: 0,
    writeWindowStart: now,
  });
  return (await ctx.db.get(id))!;
}

/**
 * Resolves (creating if needed) the caller's volunteer row and returns it ready to render.
 *
 * Signed in: the account's row — linking this device's guest row to the account on first
 * sign-in. Signed out: the device's guest row. Call it again whenever sign-in state changes.
 *
 * It also schedules internal.seed.ensure and internal.sim.kick at runAfter(0). That is what makes
 * a cold, wiped, or overnight-idle deployment heal and wake the instant someone opens the app.
 */
export const ensure = mutation({
  args: { deviceKey: v.string() },
  returns: selfShape,
  handler: async (ctx, args) => {
    const deviceKey = assertClientDeviceKey(args.deviceKey);
    const now = Date.now();
    const signedIn = (await getAuthUserId(ctx)) !== null;
    const row = signedIn
      ? await accountVolunteer(ctx, deviceKey, now)
      : await guestVolunteer(ctx, deviceKey, now);

    await ctx.scheduler.runAfter(0, internal.seed.ensure, {});
    await ctx.scheduler.runAfter(0, internal.sim.kick, {});
    return toSelf(row);
  },
});

/**
 * Sets the name neighbours see. Also marks the name as chosen, which is what stops the
 * first-open "What should neighbours call you?" step from asking again.
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
    await ctx.db.patch(volunteer._id, { handle, glyph, nameChosen: true });
    return { handle, glyph };
  },
});

/** The caller as the UI shows them. null (never an error) when nobody matches yet. */
export const me = query({
  args: { deviceKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      handle: v.string(),
      glyph: v.string(),
      colorIndex: v.number(),
      nameChosen: v.boolean(),
      verified: v.boolean(),
      username: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { deviceKey }) => {
    const row = await resolveVolunteer(ctx, deviceKey);
    if (!row) return null;
    let username: string | null = null;
    if (row.userId !== undefined) {
      // The Password provider's account id is the username, stored in users.email by design.
      username = (await ctx.db.get(row.userId))?.email ?? null;
    }
    return {
      handle: row.handle,
      glyph: row.glyph,
      colorIndex: row.colorIndex,
      nameChosen: row.nameChosen === true,
      verified: row.userId !== undefined,
      username,
    };
  },
});
