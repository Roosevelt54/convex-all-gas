/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const HOUR = 3600_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 18, 16, 0, 0);

type T = ReturnType<typeof newT>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function newT() {
  return convexTest(schema, modules);
}

async function makeUser(t: T, username: string, name?: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => ctx.db.insert("users", { email: username, name: name ?? username }));
}

function signedIn(t: T, userId: Id<"users">) {
  // getAuthUserId takes everything before the first "|" of the JWT subject.
  return t.withIdentity({ subject: `${userId}|session-1` });
}

async function expectCode(p: Promise<unknown>, code: string) {
  let caught: unknown = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected a ${code} error`).not.toBeNull();
  const data = caught instanceof ConvexError ? (caught.data as { code?: string }) : null;
  const got = data?.code ?? String((caught as Error).message);
  expect(got).toContain(code);
}

const projectArgs = {
  title: "Riverside Cleanup",
  summary: "Pull litter from the east bank.",
  orgName: "Friends of the River",
  locationLabel: "East bank, Pier 3",
  tags: ["Outdoors", "cleanup"],
};

function shiftArgs(projectId: Id<"projects">, over: Record<string, unknown> = {}) {
  return {
    projectId,
    title: "Morning litter pick",
    role: "Picker",
    startsAt: Date.now() + 2 * HOUR,
    endsAt: Date.now() + 4 * HOUR,
    capacity: 4,
    meetPoint: "Pier 3 gate",
    bring: ["Gloves", "Water"],
    skillTag: "outdoors",
    ...over,
  };
}

async function insertGuest(t: T, deviceKey: string): Promise<Id<"volunteers">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("volunteers", {
      deviceKey,
      handle: "Test Guest",
      glyph: "TG",
      colorIndex: 1,
      isSeed: false,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      writeCount: 0,
      writeWindowStart: Date.now(),
    }),
  );
}

describe("1. organizer authz", () => {
  test("signed-out, wrong organizer, and the happy path", async () => {
    const t = newT();
    await expectCode(t.mutation(api.organize.createProject, projectArgs), "NO_ACCOUNT");

    const alice = await makeUser(t, "alice", "Alice");
    const bob = await makeUser(t, "bob", "Bob");
    const asAlice = signedIn(t, alice);
    const asBob = signedIn(t, bob);

    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    await expectCode(asBob.mutation(api.organize.createShift, shiftArgs(projectId)), "NOT_YOURS");
    await expectCode(t.mutation(api.organize.createShift, shiftArgs(projectId)), "NO_ACCOUNT");

    const shiftId = await asAlice.mutation(api.organize.createShift, shiftArgs(projectId));
    const snap = await t.query(api.board.snapshot, {});
    const project = snap.projects.find((p) => p._id === projectId);
    expect(project).toMatchObject({ organizerName: "Alice", isSeed: false });
    const shift = snap.shifts.find((s) => s._id === shiftId);
    expect(shift).toMatchObject({ status: "open", opensAt: null, interestCount: 0, isSeed: false });

    // Only the organizer may add capacity to a real project's shift.
    await asBob.mutation(api.volunteers.ensure, { deviceKey: "bob-device-0001" });
    await expectCode(
      asBob.mutation(api.shifts.addCapacity, { deviceKey: "bob-device-0001", shiftId, delta: 2 }),
      "NOT_YOURS",
    );
    await expectCode(asBob.mutation(api.organize.cancelShift, { shiftId }), "NOT_YOURS");
    await asAlice.mutation(api.volunteers.ensure, { deviceKey: "alice-device-01" });
    const grown = await asAlice.mutation(api.shifts.addCapacity, {
      deviceKey: "alice-device-01",
      shiftId,
      delta: 2,
    });
    expect(grown.capacity).toBe(6);

    const mine = await asAlice.query(api.organize.myProjects, {});
    expect(mine).toHaveLength(1);
    expect(mine[0].shifts.map((s) => s._id)).toEqual([shiftId]);
    expect(await asBob.query(api.organize.myProjects, {})).toEqual([]);
    expect(await t.query(api.organize.myProjects, {})).toEqual([]);

    const detail = await asAlice.query(api.shifts.detail, { shiftId, deviceKey: "alice-device-01" });
    expect(detail.canOrganize).toBe(true);
    expect(detail.project?.organizerName).toBe("Alice");
    const bobDetail = await asBob.query(api.shifts.detail, { shiftId, deviceKey: "bob-device-0001" });
    expect(bobDetail.canOrganize).toBe(false);

    await asAlice.mutation(api.organize.cancelShift, { shiftId });
    const cancelled = await t.run(async (ctx) => ctx.db.get(shiftId));
    expect(cancelled?.status).toBe("cancelled");
  });
});

describe("2. timed unlock", () => {
  test("not_open until the scheduled open fires, then claimable", async () => {
    const t = newT();
    const alice = await makeUser(t, "alice", "Alice");
    const asAlice = signedIn(t, alice);
    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    const opensAt = Date.now() + 10 * MIN;
    const shiftId = await asAlice.mutation(
      api.organize.createShift,
      shiftArgs(projectId, { opensAt }),
    );

    const snap = await t.query(api.board.snapshot, {});
    expect(snap.stats.opensSoonCount).toBe(1);
    expect(snap.shifts.find((s) => s._id === shiftId)).toMatchObject({ status: "scheduled", opensAt });

    const DK = "guest-device-0001";
    await insertGuest(t, DK);
    const early = await t.mutation(api.shifts.claim, { deviceKey: DK, shiftId });
    expect(early).toEqual({ outcome: "not_open", opensAt });

    expect(await t.mutation(api.shifts.toggleInterest, { deviceKey: DK, shiftId })).toEqual({
      interested: true,
      count: 1,
    });
    const mine = await t.query(api.board.myCommitments, { deviceKey: DK });
    expect(mine.interests).toEqual([shiftId]);
    const d = await t.query(api.shifts.detail, { shiftId, deviceKey: DK });
    expect(d.youAreInterested).toBe(true);
    expect(d.shift?.interestCount).toBe(1);

    vi.advanceTimersByTime(11 * MIN);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const opened = await t.run(async (ctx) => ctx.db.get(shiftId));
    expect(opened?.status).toBe("open");
    expect(opened?.openJobId).toBeUndefined();
    expect(opened?.lastChangeKind).toBe("opened");
    const feed = await t.query(api.activity.recent, {});
    expect(feed.some((a) => a.kind === "opened" && a.shiftId === shiftId)).toBe(true);

    await expectCode(t.mutation(api.shifts.toggleInterest, { deviceKey: DK, shiftId }), "BAD_INPUT");
    const claimed = await t.mutation(api.shifts.claim, { deviceKey: DK, shiftId });
    expect(claimed.outcome).toBe("claimed");
  });

  test("openNow opens immediately and cancels the scheduled job", async () => {
    const t = newT();
    const alice = await makeUser(t, "alice", "Alice");
    const asAlice = signedIn(t, alice);
    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    const shiftId = await asAlice.mutation(
      api.organize.createShift,
      shiftArgs(projectId, { opensAt: Date.now() + 30 * MIN }),
    );
    const before = await t.run(async (ctx) => ctx.db.get(shiftId));
    const jobId = before!.openJobId!;
    expect(jobId).toBeDefined();

    const bob = await makeUser(t, "bob", "Bob");
    await expectCode(signedIn(t, bob).mutation(api.organize.openNow, { shiftId }), "NOT_YOURS");

    await asAlice.mutation(api.organize.openNow, { shiftId });
    const after = await t.run(async (ctx) => ctx.db.get(shiftId));
    expect(after?.status).toBe("open");
    expect(after?.openJobId).toBeUndefined();
    const job = await t.run(async (ctx) => ctx.db.system.get(jobId));
    expect(job?.state.kind).toBe("canceled");
    await expectCode(asAlice.mutation(api.organize.openNow, { shiftId }), "BAD_INPUT");
  });
});

describe("3. identity", () => {
  test("guest claim is linked to the account on sign-in; sign-out gets a fresh guest", async () => {
    const t = newT();
    const alice = await makeUser(t, "alice", "Alice");
    const asAlice = signedIn(t, alice);
    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    const shiftId = await asAlice.mutation(api.organize.createShift, shiftArgs(projectId));

    const DK = "device-mike-0001";
    const guest = await t.mutation(api.volunteers.ensure, { deviceKey: DK });
    expect(guest).toMatchObject({ nameChosen: false, verified: false });
    const claim = await t.mutation(api.shifts.claim, { deviceKey: DK, shiftId });
    expect(claim.outcome).toBe("claimed");

    const mike = await makeUser(t, "mike", "Mike");
    const asMike = signedIn(t, mike);
    const linked = await asMike.mutation(api.volunteers.ensure, { deviceKey: DK });
    expect(linked._id).toBe(guest._id);
    expect(linked).toMatchObject({ verified: true, nameChosen: true, handle: "Mike" });

    const row = await t.run(async (ctx) => ctx.db.get(guest._id));
    expect(row?.deviceKey).toBe(`acct:${mike}`);
    expect(row?.userId).toBe(mike);
    const claims = await t.run(async (ctx) =>
      ctx.db
        .query("claims")
        .withIndex("by_shift_volunteer", (q) => q.eq("shiftId", shiftId))
        .collect(),
    );
    expect(claims.map((c) => c.volunteerId)).toEqual([guest._id]);

    const mikeView = await asMike.query(api.board.myCommitments, { deviceKey: DK });
    expect(mikeView.volunteer).toMatchObject({ handle: "Mike", verified: true });
    expect(mikeView.claims.map((c) => c.shiftId)).toEqual([shiftId]);
    const detail = await asMike.query(api.shifts.detail, { shiftId, deviceKey: DK });
    expect(detail.roster[0]).toMatchObject({ isYou: true, verified: true, handle: "Mike" });
    expect(detail.yourClaim?.kind).toBe("spot");

    // Ensure is idempotent for the account, whatever device it is called from.
    const again = await asMike.mutation(api.volunteers.ensure, { deviceKey: "another-device-9" });
    expect(again._id).toBe(guest._id);

    // Signed out on the same device: a brand-new guest with none of Mike's claims.
    const fresh = await t.mutation(api.volunteers.ensure, { deviceKey: DK });
    expect(fresh._id).not.toBe(guest._id);
    expect(fresh).toMatchObject({ verified: false, nameChosen: false });
    const guestView = await t.query(api.board.myCommitments, { deviceKey: DK });
    expect(guestView.claims).toEqual([]);
    const guestDetail = await t.query(api.shifts.detail, { shiftId, deviceKey: DK });
    expect(guestDetail.yourClaim).toBeNull();
    expect(guestDetail.roster[0]).toMatchObject({ isYou: false, verified: true });
  });

  test("reserved device-key prefixes are rejected", async () => {
    const t = newT();
    const mike = await makeUser(t, "mike", "Mike");
    await expectCode(t.mutation(api.volunteers.ensure, { deviceKey: `acct:${mike}` }), "BAD_INPUT");
    await expectCode(t.mutation(api.volunteers.ensure, { deviceKey: "seed:seed-volunteer-0-0" }), "BAD_INPUT");
    await expectCode(
      t.mutation(api.volunteers.rename, { deviceKey: "seed:seed-volunteer-0-0", handle: "Evil" }),
      "BAD_INPUT",
    );
    await expectCode(t.mutation(api.volunteers.ensure, { deviceKey: "short" }), "BAD_INPUT");
    // Queries never throw on a reserved key; they just see nobody.
    expect(await t.query(api.volunteers.me, { deviceKey: "seed:seed-volunteer-0-0" })).toBeNull();
  });

  test("a signed-out caller cannot use an account-owned row", async () => {
    const t = newT();
    const mike = await makeUser(t, "mike", "Mike");
    const alice = await makeUser(t, "alice", "Alice");
    const asAlice = signedIn(t, alice);
    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    const shiftId = await asAlice.mutation(api.organize.createShift, shiftArgs(projectId));

    const DK = "owned-device-0001";
    await t.run(async (ctx) =>
      ctx.db.insert("volunteers", {
        deviceKey: DK,
        userId: mike,
        nameChosen: true,
        handle: "Mike",
        glyph: "MI",
        colorIndex: 2,
        isSeed: false,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        writeCount: 0,
        writeWindowStart: Date.now(),
      }),
    );
    await expectCode(t.mutation(api.shifts.claim, { deviceKey: DK, shiftId }), "NO_IDENTITY");
    expect((await t.query(api.board.myCommitments, { deviceKey: DK })).volunteer).toBeNull();
    expect(await t.query(api.volunteers.me, { deviceKey: DK })).toBeNull();
  });
});

describe("4. names", () => {
  test("rename sets nameChosen and me() reports it", async () => {
    const t = newT();
    const DK = "device-jerry-001";
    await t.mutation(api.volunteers.ensure, { deviceKey: DK });
    expect(await t.query(api.volunteers.me, { deviceKey: DK })).toMatchObject({
      nameChosen: false,
      verified: false,
      username: null,
    });
    await t.mutation(api.volunteers.rename, { deviceKey: DK, handle: "  Jerry  " });
    expect(await t.query(api.volunteers.me, { deviceKey: DK })).toMatchObject({
      handle: "Jerry",
      glyph: "JE",
      nameChosen: true,
      verified: false,
      username: null,
    });

    // A chosen guest name survives linking to an account.
    const jerry = await makeUser(t, "jerry_k", "Jerry K");
    const asJerry = signedIn(t, jerry);
    const linked = await asJerry.mutation(api.volunteers.ensure, { deviceKey: DK });
    expect(linked.handle).toBe("Jerry");
    expect(await asJerry.query(api.volunteers.me, { deviceKey: DK })).toMatchObject({
      handle: "Jerry",
      nameChosen: true,
      verified: true,
      username: "jerry_k",
    });
  });
});

describe("5. simulator safety", () => {
  test("the pulse never claims on a non-seed shift", async () => {
    const t = newT();
    const alice = await makeUser(t, "alice", "Alice");
    const now = Date.now();
    const realShift = await t.run(async (ctx) => {
      await ctx.db.insert("meta", {
        key: "main",
        seedVersion: 5,
        pulseEnabled: true,
        pulseRunning: true,
        pulseToken: "tok",
        lastPulseAt: now,
        lastSeededAt: now,
      });
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("volunteers", {
          deviceKey: `seed:seed-volunteer-${i}-0`,
          handle: `Seed ${i}`,
          glyph: "S" + i,
          colorIndex: i,
          isSeed: true,
          createdAt: now,
          lastSeenAt: now,
          writeCount: 0,
          writeWindowStart: now,
        });
      }
      const watcher = await ctx.db.insert("volunteers", {
        deviceKey: "watcher-device-01",
        handle: "Watcher",
        glyph: "WA",
        colorIndex: 0,
        isSeed: false,
        createdAt: now,
        lastSeenAt: now,
        writeCount: 0,
        writeWindowStart: now,
      });
      await ctx.db.insert("presence", {
        volunteerId: watcher,
        deviceKey: "watcher-device-01",
        scope: "board",
        isActive: true,
        lastPingAt: now,
        handle: "Watcher",
        glyph: "WA",
        colorIndex: 0,
      });
      const projectId = await ctx.db.insert("projects", {
        slug: "real-project",
        title: "Real project",
        summary: "",
        orgName: "Real org",
        locationLabel: "Here",
        accentIndex: 0,
        tags: [],
        isSeed: false,
        organizerId: alice,
        organizerName: "Alice",
        createdAt: now,
      });
      return await ctx.db.insert("shifts", {
        projectId,
        title: "Real shift",
        role: "Helper",
        startsAt: now + 2 * HOUR,
        endsAt: now + 3 * HOUR,
        capacity: 10,
        filledCount: 0,
        waitlistCount: 0,
        waitlistSeq: 0,
        interestCount: 0,
        status: "open",
        meetPoint: "Gate",
        bring: [],
        skillTag: "general",
        lastChangeAt: now,
        lastChangeKind: "posted",
        lastChangeActorName: "Alice",
        lastChangeIsSim: false,
        lastHumanTouchAt: 0,
        isSeed: false,
      });
    });

    for (let i = 0; i < 6; i++) {
      await t.mutation(internal.sim.tick, { token: "tok" });
    }
    const countClaims = async (shiftId: Id<"shifts">) =>
      (
        await t.run(async (ctx) =>
          ctx.db
            .query("claims")
            .withIndex("by_shift_volunteer", (q) => q.eq("shiftId", shiftId))
            .collect(),
        )
      ).length;
    expect(await countClaims(realShift)).toBe(0);

    // Control: with a seeded shift present the same tick DOES act — on the seeded shift only.
    const seedShift = await t.run(async (ctx) => {
      const seedProject = await ctx.db.insert("projects", {
        slug: "seed-project",
        title: "Seed project",
        summary: "",
        orgName: "Seed org",
        locationLabel: "There",
        accentIndex: 1,
        tags: [],
        isSeed: true,
        createdAt: now,
      });
      return await ctx.db.insert("shifts", {
        projectId: seedProject,
        title: "Seed shift",
        role: "Helper",
        startsAt: now + 5 * HOUR,
        endsAt: now + 6 * HOUR,
        capacity: 10,
        filledCount: 0,
        waitlistCount: 0,
        waitlistSeq: 0,
        status: "open",
        meetPoint: "Gate",
        bring: [],
        skillTag: "general",
        lastChangeAt: now,
        lastChangeKind: "seeded",
        lastChangeActorName: "Seed org",
        lastChangeIsSim: true,
        lastHumanTouchAt: 0,
        isSeed: true,
      });
    });
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.sim.tick, { token: "tok" });
    }
    expect(await countClaims(seedShift)).toBeGreaterThan(0);
    expect(await countClaims(realShift)).toBe(0);
  });
});

describe("6. validation", () => {
  test("createShift and createProject reject out-of-range input", async () => {
    const t = newT();
    const alice = await makeUser(t, "alice", "Alice");
    const asAlice = signedIn(t, alice);
    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    const now = Date.now();
    const bad: Array<Record<string, unknown>> = [
      { capacity: 0 },
      { capacity: 25 },
      { capacity: 2.5 },
      { endsAt: now + 2 * HOUR },
      { endsAt: now + 1 * HOUR },
      { endsAt: now + 15 * HOUR },
      { startsAt: now + 8 * 24 * HOUR, endsAt: now + 8 * 24 * HOUR + HOUR },
      { startsAt: now - HOUR, endsAt: now + HOUR },
      { opensAt: now + 3 * HOUR },
      { opensAt: now + 2 * HOUR },
      { opensAt: now + 30_000 },
      { title: "ab" },
      { skillTag: "Has Space" },
      { bring: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
    ];
    for (const over of bad) {
      await expectCode(asAlice.mutation(api.organize.createShift, shiftArgs(projectId, over)), "BAD_INPUT");
    }
    await expectCode(asAlice.mutation(api.organize.createProject, { ...projectArgs, title: "ab" }), "BAD_INPUT");
    await expectCode(
      asAlice.mutation(api.organize.createProject, { ...projectArgs, tags: ["a", "b", "c", "d", "e", "f"] }),
      "BAD_INPUT",
    );
    // The allowed edges.
    const ok = await asAlice.mutation(
      api.organize.createShift,
      shiftArgs(projectId, { capacity: 24, opensAt: now + 60_000 }),
    );
    expect(ok).toBeDefined();
  });
});

describe("7. review fixes", () => {
  test("one organizer cannot flood the board: 20 upcoming shifts max", async () => {
    const t = newT();
    const alice = await makeUser(t, "alice", "Alice");
    const asAlice = signedIn(t, alice);
    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    for (let i = 0; i < 20; i++) {
      await asAlice.mutation(
        api.organize.createShift,
        shiftArgs(projectId, { startsAt: Date.now() + (i + 1) * MIN, endsAt: Date.now() + 2 * HOUR }),
      );
    }
    await expectCode(asAlice.mutation(api.organize.createShift, shiftArgs(projectId)), "BAD_INPUT");
  });

  test("a cancelled shift neither blocks a replacement nor promotes its waitlist", async () => {
    const t = newT();
    const alice = await makeUser(t, "alice", "Alice");
    const asAlice = signedIn(t, alice);
    const projectId = await asAlice.mutation(api.organize.createProject, projectArgs);
    const shiftA = await asAlice.mutation(api.organize.createShift, shiftArgs(projectId, { capacity: 1 }));
    const shiftB = await asAlice.mutation(api.organize.createShift, shiftArgs(projectId, { capacity: 1 }));

    const G1 = "guest-one-device";
    const G2 = "guest-two-device";
    await t.mutation(api.volunteers.ensure, { deviceKey: G1 });
    await t.mutation(api.volunteers.ensure, { deviceKey: G2 });
    expect((await t.mutation(api.shifts.claim, { deviceKey: G1, shiftId: shiftA })).outcome).toBe("claimed");
    expect((await t.mutation(api.shifts.claim, { deviceKey: G2, shiftId: shiftA })).outcome).toBe("waitlisted");

    await asAlice.mutation(api.organize.cancelShift, { shiftId: shiftA });
    // The cancelled spot must not count as an overlap against the replacement.
    expect((await t.mutation(api.shifts.claim, { deviceKey: G1, shiftId: shiftB })).outcome).toBe("claimed");
    // Releasing it just clears the claim; nobody is promoted into a cancelled shift.
    expect(await t.mutation(api.shifts.release, { deviceKey: G1, shiftId: shiftA })).toEqual({
      outcome: "released",
      promoted: null,
    });
    const g2 = await t.query(api.shifts.detail, { shiftId: shiftA, deviceKey: G2 });
    expect(g2.yourClaim?.kind).toBe("waitlist");
    expect(g2.roster).toHaveLength(0);
  });

  test("rollForward drops a human claim on an ended demo shift instead of moving it", async () => {
    const t = newT();
    const now = Date.now();
    const { shiftId, humanId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        slug: "seed-p", title: "Seed p", summary: "", orgName: "o", locationLabel: "l",
        accentIndex: 0, tags: [], isSeed: true, createdAt: now,
      });
      const shiftId = await ctx.db.insert("shifts", {
        projectId, title: "Ended demo shift", role: "r",
        startsAt: now - 5 * HOUR, endsAt: now - 2 * HOUR,
        capacity: 4, filledCount: 2, waitlistCount: 0, waitlistSeq: 0, status: "open",
        meetPoint: "m", bring: [], skillTag: "general",
        lastChangeAt: now, lastChangeKind: "seeded", lastChangeActorName: "o",
        lastChangeIsSim: true, lastHumanTouchAt: 0, isSeed: true,
      });
      const mk = async (isSeed: boolean, deviceKey: string) =>
        ctx.db.insert("volunteers", {
          deviceKey, handle: deviceKey, glyph: "XX", colorIndex: 0, isSeed,
          createdAt: now, lastSeenAt: now, writeCount: 0, writeWindowStart: now,
        });
      const seedId = await mk(true, "seed:rf-0");
      const humanId = await mk(false, "rf-human-dev");
      for (const [i, v, isSeed] of [[0, seedId, true], [1, humanId, false]] as const) {
        await ctx.db.insert("claims", {
          shiftId, projectId, volunteerId: v, kind: "spot", position: i,
          startsAt: now - 5 * HOUR, endsAt: now - 2 * HOUR, isSeed, createdAt: now,
        });
      }
      return { shiftId, humanId };
    });

    await t.mutation(internal.seed.rollForward, {});
    const after = await t.run(async (ctx) => ({
      shift: await ctx.db.get(shiftId),
      claims: await ctx.db
        .query("claims")
        .withIndex("by_shift_volunteer", (q) => q.eq("shiftId", shiftId))
        .collect(),
    }));
    expect(after.shift!.startsAt).toBeGreaterThan(now);
    expect(after.claims.some((c) => c.volunteerId === humanId)).toBe(false);
    expect(after.claims).toHaveLength(1);
    expect(after.shift!.filledCount).toBe(1);
  });

  test("the watchdog prunes simulated activity only", async () => {
    const t = newT();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("activity", {
        kind: "posted", actorName: "Alice", message: "Alice posted a real shift", isSim: false,
        createdAt: now - 10 * HOUR,
      });
      for (let i = 0; i < 305; i++) {
        await ctx.db.insert("activity", {
          kind: "claimed", actorName: "Sim", message: `sim ${i}`, isSim: true, createdAt: now - i,
        });
      }
    });
    await t.mutation(internal.sim.watchdog, {});
    const rows = await t.run(async (ctx) => ctx.db.query("activity").take(400));
    expect(rows.some((r) => !r.isSim)).toBe(true);
    expect(rows.filter((r) => r.isSim).length).toBeLessThan(305);
  });
});
