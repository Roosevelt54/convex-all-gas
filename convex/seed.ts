import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { generateHandle, hashString, initials, readSpotClaims, readWaitlist } from "./lib";
import type { ActivityKind, ChangeKind } from "./lib";

/**
 * Bump this to force a reseed on the next ensure(). Idempotence is keyed on it, so an
 * unchanged version plus at least one shift means ensure() is a no-op.
 */
const SEED_VERSION = 6;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const VOLUNTEER_COUNT = 24;
const ACTIVITY_ROWS = 40;
const REANCHOR_WINDOW_MS = 3 * HOUR;
/** Cold-path wipe bound. Seed scale is ~230 rows per table and the watchdog caps activity at 300. */
const WIPE_SCAN_LIMIT = 4096;

/* ------------------------------------------------------------------------------------------- *
 * Deterministic randomness. Math.random() is never used: the fill distribution below is tuned,
 * and a tuned dataset that shuffles differently on every deploy is not a tuned dataset.
 * ------------------------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------------------------- *
 * Content
 * ------------------------------------------------------------------------------------------- */

type ProjectSeed = {
  slug: string;
  title: string;
  summary: string;
  orgName: string;
  locationLabel: string;
  accentIndex: number;
  tags: string[];
  meetPoint: string;
  bring: string[];
  skillTag: string;
};

const PROJECTS: ProjectSeed[] = [
  {
    slug: "riverbank-cleanup",
    title: "Riverbank Cleanup",
    summary:
      "Pull trash and cut invasive vine off the Mill Creek bank before the spring melt carries it downstream.",
    orgName: "Friends of Mill Creek",
    locationLabel: "Mill Creek Landing",
    accentIndex: 0,
    tags: ["outdoors", "waterfront", "family-friendly"],
    meetPoint: "Mill Creek Landing, lower lot by the map kiosk",
    bring: ["Work gloves", "Water bottle", "Closed-toe shoes"],
    skillTag: "outdoors",
  },
  {
    slug: "food-bank-sorting-line",
    title: "Food Bank Sorting Line",
    summary:
      "Break down pallets, sort produce and pack family boxes so the Saturday distribution never runs short.",
    orgName: "Eastside Food Bank",
    locationLabel: "Eastside Food Bank, Dock B",
    accentIndex: 1,
    tags: ["indoors", "food", "all-ages"],
    meetPoint: "Dock B roll-up door, ring the bell",
    bring: ["Closed-toe shoes", "Hair tie or cap"],
    skillTag: "indoors",
  },
  {
    slug: "tool-library-repair-cafe",
    title: "Tool Library Repair Café",
    summary:
      "Neighbors bring broken lamps, bikes and sewing machines; you and a bench of spare parts send them home working.",
    orgName: "Carver Tool Library",
    locationLabel: "Carver Tool Library, back workshop",
    accentIndex: 2,
    tags: ["repair", "indoors", "skill-share"],
    meetPoint: "Back workshop door on Carver Alley",
    bring: ["Reading glasses if you use them", "A broken thing to practice on"],
    skillTag: "repair",
  },
  {
    slug: "school-garden-build",
    title: "School Garden Build",
    summary:
      "Frame beds, haul soil and get fourteen raised beds planted before the third graders come back on Monday.",
    orgName: "Lincoln Elementary PTA",
    locationLabel: "Lincoln Elementary, Gate 3",
    accentIndex: 3,
    tags: ["build", "outdoors", "schools"],
    meetPoint: "Gate 3 on Lincoln Ave, look for the soil pile",
    bring: ["Work gloves", "Sun hat", "Cordless drill (optional)"],
    skillTag: "build",
  },
  {
    slug: "warming-shelter-overnight",
    title: "Warming Shelter Overnight",
    summary:
      "Greet arrivals, keep the coffee going and steward the bunk room so the shelter can stay open all night.",
    orgName: "St. Bride's Hall",
    locationLabel: "St. Bride's Hall, side entrance",
    accentIndex: 4,
    tags: ["care", "overnight", "training-provided"],
    meetPoint: "Side entrance on Bride Street, under the awning",
    bring: ["Photo ID", "Warm layers", "Something to read at 3am"],
    skillTag: "care",
  },
  {
    slug: "riverside-trail-rebuild",
    title: "Riverside Trail Rebuild",
    summary:
      "Cut new tread, set rock stairs and deck the footbridge on the washed-out half mile below the bluff.",
    orgName: "Riverside Trail Alliance",
    locationLabel: "Trailhead lot off Route 9",
    accentIndex: 5,
    tags: ["trail", "outdoors", "heavy-lifting"],
    meetPoint: "Trailhead lot off Route 9, by the green gate",
    bring: ["Work gloves", "Sturdy boots", "Packed lunch"],
    skillTag: "trail",
  },
];

/**
 * THE TUNED FILL DISTRIBUTION. Read the buckets, not the numbers:
 *   exactly 1 spot left       : rows 2, 6, 22                      -> 3 shifts
 *   full + 3-person waitlist  : rows 3, 12                         -> 2 shifts
 *   50-70% full               : rows 1, 4, 9, 13, 18, 24           -> 6 shifts
 *   wide open (0 filled)      : rows 5, 15, 25, 30                 -> 4 shifts
 *   scattered (outside 50-70%): the remaining 15
 * Totals: 221 spots, 128 filled = 57.9% global fill, inside the pulse's 40-70% steering band.
 *
 * `day: 0` means "today": `hour` is then a slot index (0,1,2) into three relative slots anchored
 * off Date.now(), so something always starts within a couple of hours no matter when this runs.
 * `day >= 1` anchors on the UTC day boundary at that hour.
 */
type ShiftSeed = {
  p: number;
  day: number;
  hour: number;
  durH: number;
  role: string;
  phrase: string;
  capacity: number;
  filled: number;
  waitlist: number;
};

const SHIFTS: ShiftSeed[] = [
  // today
  { p: 0, day: 0, hour: 0, durH: 3, role: "Lifter", phrase: "Haul & sort", capacity: 8, filled: 5, waitlist: 0 },
  { p: 1, day: 0, hour: 1, durH: 3, role: "Sorter", phrase: "Produce sort", capacity: 6, filled: 5, waitlist: 0 },
  { p: 4, day: 0, hour: 2, durH: 6, role: "Greeter", phrase: "Evening intake", capacity: 4, filled: 4, waitlist: 3 },
  // +1 day
  { p: 0, day: 1, hour: 9, durH: 3, role: "Lifter", phrase: "Shoreline sweep", capacity: 10, filled: 6, waitlist: 0 },
  { p: 3, day: 1, hour: 9, durH: 4, role: "Builder", phrase: "Bed framing", capacity: 6, filled: 0, waitlist: 0 },
  { p: 2, day: 1, hour: 13, durH: 3, role: "Fixer", phrase: "Small appliance triage", capacity: 5, filled: 4, waitlist: 0 },
  { p: 1, day: 1, hour: 17, durH: 3, role: "Packer", phrase: "Family box pack", capacity: 10, filled: 8, waitlist: 0 },
  { p: 5, day: 1, hour: 20, durH: 2, role: "Trail crew", phrase: "Headlamp brush clearing", capacity: 4, filled: 1, waitlist: 0 },
  // +2 days
  { p: 5, day: 2, hour: 8, durH: 4, role: "Trail crew", phrase: "Tread cutting", capacity: 12, filled: 7, waitlist: 0 },
  { p: 1, day: 2, hour: 12, durH: 3, role: "Sorter", phrase: "Pallet breakdown", capacity: 12, filled: 5, waitlist: 0 },
  { p: 2, day: 2, hour: 16, durH: 3, role: "Fixer", phrase: "Bike tune-up bench", capacity: 6, filled: 2, waitlist: 0 },
  { p: 4, day: 2, hour: 19, durH: 10, role: "Overnight steward", phrase: "Overnight steward", capacity: 6, filled: 6, waitlist: 3 },
  // +3 days
  { p: 3, day: 3, hour: 9, durH: 4, role: "Digger", phrase: "Soil haul", capacity: 6, filled: 4, waitlist: 0 },
  { p: 0, day: 3, hour: 11, durH: 3, role: "Paddler", phrase: "Kayak litter run", capacity: 8, filled: 3, waitlist: 0 },
  { p: 2, day: 3, hour: 14, durH: 3, role: "Host", phrase: "Intake desk", capacity: 5, filled: 0, waitlist: 0 },
  { p: 1, day: 3, hour: 18, durH: 3, role: "Sorter", phrase: "Evening sort line", capacity: 12, filled: 10, waitlist: 0 },
  // +4 days
  { p: 5, day: 4, hour: 8, durH: 5, role: "Rock crew", phrase: "Rock stairs", capacity: 12, filled: 10, waitlist: 0 },
  { p: 0, day: 4, hour: 10, durH: 3, role: "Weigher", phrase: "Weigh-in & wrap-up", capacity: 4, filled: 2, waitlist: 0 },
  { p: 3, day: 4, hour: 13, durH: 4, role: "Spreader", phrase: "Mulch spread", capacity: 10, filled: 4, waitlist: 0 },
  { p: 2, day: 4, hour: 17, durH: 3, role: "Fixer", phrase: "Sewing machine clinic", capacity: 5, filled: 2, waitlist: 0 },
  { p: 4, day: 4, hour: 20, durH: 10, role: "Overnight steward", phrase: "Bunk turnover", capacity: 9, filled: 4, waitlist: 0 },
  // +5 days
  { p: 0, day: 5, hour: 9, durH: 3, role: "Lifter", phrase: "Haul & sort", capacity: 8, filled: 7, waitlist: 0 },
  { p: 1, day: 5, hour: 12, durH: 3, role: "Restocker", phrase: "Dry goods restock", capacity: 8, filled: 6, waitlist: 0 },
  { p: 5, day: 5, hour: 15, durH: 3, role: "Sign crew", phrase: "Signage & blazes", capacity: 9, filled: 6, waitlist: 0 },
  { p: 3, day: 5, hour: 19, durH: 2, role: "Waterer", phrase: "Evening watering", capacity: 4, filled: 0, waitlist: 0 },
  // +6 days
  { p: 5, day: 6, hour: 8, durH: 4, role: "Deck crew", phrase: "Bridge decking", capacity: 10, filled: 8, waitlist: 0 },
  { p: 2, day: 6, hour: 10, durH: 3, role: "Sharpener", phrase: "Sharpening bench", capacity: 5, filled: 2, waitlist: 0 },
  { p: 0, day: 6, hour: 13, durH: 3, role: "Sorter", phrase: "Bag weigh & log", capacity: 6, filled: 2, waitlist: 0 },
  { p: 3, day: 6, hour: 16, durH: 3, role: "Planter", phrase: "Planting day", capacity: 7, filled: 5, waitlist: 0 },
  { p: 4, day: 6, hour: 19, durH: 10, role: "Greeter", phrase: "Morning send-off prep", capacity: 4, filled: 0, waitlist: 0 },
];

/**
 * Ascending "how long ago" offsets at IRREGULAR intervals (26s, then 20s-8m steps), scaled to fit
 * inside `spanMs` so the feed always reads as the last few hours of a neighborhood, not a
 * metronome and not last week.
 */
function irregularOffsets(count: number, rng: () => number, spanMs: number): number[] {
  const out: number[] = [];
  let cursor = 26_000;
  for (let i = 0; i < count; i++) {
    out.push(cursor);
    cursor += Math.floor(20_000 + rng() * 470_000);
  }
  const max = out.length > 0 ? out[out.length - 1] : 0;
  if (max <= spanMs || max === 0) return out;
  const scale = spanMs / max;
  return out.map((o) => Math.max(1_000, Math.floor(o * scale)));
}

/**
 * "9am", "4:30pm" — derived from the stored timestamp, so a title can never contradict its own
 * shift. Deliberately carries no weekday word: rollForward moves shifts by WHOLE days, which keeps
 * a time-of-day label true forever but would make a baked-in "Saturday" a lie.
 */
/* ------------------------------------------------------------------------------------------- *
 * Wipe
 * ------------------------------------------------------------------------------------------- */

async function wipeSeeded(ctx: MutationCtx): Promise<void> {
  // Bounded cold-path scans. Claims go first so no claim ever outlives the shift it points at.
  // A HUMAN claim (isSeed=false) on a seeded shift must go too: otherwise it survives as an
  // orphan whose denormalized startsAt/endsAt still sit in by_volunteer_starts, and applyClaim's
  // overlap check reports a phantom "overlaps another shift" conflict against a deleted shift.
  const seededShifts = (await ctx.db.query("shifts").take(WIPE_SCAN_LIMIT)).filter((s) => s.isSeed);
  const seededShiftIds = new Set(seededShifts.map((s) => s._id));
  for (const row of await ctx.db.query("claims").take(WIPE_SCAN_LIMIT)) {
    if (row.isSeed || seededShiftIds.has(row.shiftId)) await ctx.db.delete(row._id);
  }
  for (const row of await ctx.db.query("interest").take(WIPE_SCAN_LIMIT)) {
    if (seededShiftIds.has(row.shiftId)) await ctx.db.delete(row._id);
  }
  for (const shift of seededShifts) {
    await ctx.db.delete(shift._id);
  }
  const seededProjectIds = new Set<string>();
  for (const row of await ctx.db.query("projects").take(WIPE_SCAN_LIMIT)) {
    if (row.isSeed) {
      seededProjectIds.add(row._id);
      await ctx.db.delete(row._id);
    }
  }
  for (const row of await ctx.db.query("volunteers").take(WIPE_SCAN_LIMIT)) {
    if (row.isSeed) await ctx.db.delete(row._id);
  }
  // Demo activity goes (a feed that outlives the shifts it references reads as broken), but a
  // REAL organizer's history stays: only simulated rows and rows about seeded shifts/projects.
  for (const row of await ctx.db.query("activity").take(WIPE_SCAN_LIMIT)) {
    const aboutSeed =
      (row.shiftId !== undefined && seededShiftIds.has(row.shiftId)) ||
      (row.projectId !== undefined && seededProjectIds.has(row.projectId));
    if (row.isSim || aboutSeed) await ctx.db.delete(row._id);
  }
}

/* ------------------------------------------------------------------------------------------- *
 * The dataset
 * ------------------------------------------------------------------------------------------- */

type SeedStats = {
  projects: number;
  shifts: number;
  volunteers: number;
  spotClaims: number;
  waitlistClaims: number;
  activity: number;
};

type SpotEvent = {
  shiftId: Id<"shifts">;
  projectId: Id<"projects">;
  volunteerId: Id<"volunteers">;
  handle: string;
  title: string;
  leftAfter: number;
};

type FullShiftStory = {
  shiftId: Id<"shifts">;
  projectId: Id<"projects">;
  title: string;
  releaserId: Id<"volunteers">;
  releaserHandle: string;
  promotedId: Id<"volunteers">;
  promotedHandle: string;
  waiters: Array<{ volunteerId: Id<"volunteers">; handle: string; rank: number }>;
};

type FeedRow = {
  kind: ActivityKind;
  projectId: Id<"projects">;
  shiftId: Id<"shifts">;
  volunteerId?: Id<"volunteers">;
  actorName: string;
  message: string;
};

/**
 * The one public community every visitor lands on. Kept (never wiped) across reseeds so its id —
 * and any link to it — stays stable.
 */
async function ensureDemoCommunity(ctx: MutationCtx, now: number): Promise<Id<"communities">> {
  const existing = await ctx.db
    .query("communities")
    .withIndex("by_seed", (q) => q.eq("isSeed", true))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("communities", {
    name: "Riverside Commons (demo)",
    description: "A public demo neighbourhood. Anyone can look around and take a shift.",
    joinCode: "publicdemo",
    isPublic: true,
    isSeed: true,
    createdAt: now,
  });
}

async function writeDataset(ctx: MutationCtx): Promise<SeedStats> {
  const now = Date.now();
  const communityId = await ensureDemoCommunity(ctx, now);
  const rng = mulberry32(hashString(`crewcall:seed:v${SEED_VERSION}`));

  // Today's three slots start on the next whole hour at least 75 minutes out, so nothing lands in
  // the past, every label is a round hour, and the board always has something starting soon.
  const base0 = Math.ceil((now + 75 * 60_000) / HOUR) * HOUR;
  // A neighbourhood board has ONE home timezone, so future-day hours are anchored to the
  // community's local midnight, not UTC's. Anchoring on UTC put a "9am" riverbank cleanup at
  // 2 AM for a Pacific viewer, which reads as fake data. Fixed UTC-7 (PDT) is exact through
  // the judging window; PDT runs until early November.
  const COMMUNITY_UTC_OFFSET_MS = -7 * HOUR;
  const dayStart = Math.floor((now + COMMUNITY_UTC_OFFSET_MS) / DAY) * DAY - COMMUNITY_UTC_OFFSET_MS;

  // --- volunteers ---------------------------------------------------------------------------
  const volunteers: Array<{ id: Id<"volunteers">; handle: string }> = [];
  const usedHandles = new Set<string>();
  for (let i = 0; i < VOLUNTEER_COUNT; i++) {
    let key = `seed-volunteer-${i}-0`;
    let handle = generateHandle(key);
    // Salt until the generated adjective+animal is unused: two neighbors with the same name in a
    // roster of 24 would make the race test unreadable.
    for (let salt = 1; salt < 96 && usedHandles.has(handle); salt++) {
      key = `seed-volunteer-${i}-${salt}`;
      handle = generateHandle(key);
    }
    usedHandles.add(handle);
    const h = hashString(key);
    const id = await ctx.db.insert("volunteers", {
      deviceKey: `seed:${key}`,
      handle,
      glyph: initials(handle),
      colorIndex: h % 8,
      isSeed: true,
      createdAt: now - (14 + (h % 120)) * DAY,
      lastSeenAt: now - Math.floor(rng() * 6 * HOUR),
      writeCount: 0,
      writeWindowStart: now,
    });
    volunteers.push({ id, handle });
  }

  // --- projects -----------------------------------------------------------------------------
  const projectIds: Array<Id<"projects">> = [];
  for (const p of PROJECTS) {
    projectIds.push(
      await ctx.db.insert("projects", {
        slug: p.slug,
        title: p.title,
        summary: p.summary,
        orgName: p.orgName,
        locationLabel: p.locationLabel,
        accentIndex: p.accentIndex,
        tags: p.tags,
        isSeed: true,
        createdAt: now - 45 * DAY,
        communityId,
      }),
    );
  }

  // --- shifts + claims ------------------------------------------------------------------------
  // A seeded volunteer never holds two overlapping spots. Claims carry denormalized startsAt/endsAt
  // and applyClaim reads them for its time-overlap check, so a self-contradicting seed would make
  // the pulse start returning "conflict" against data we wrote ourselves.
  const booked = new Map<number, Array<{ s: number; e: number }>>();
  const isFree = (vi: number, s: number, e: number): boolean => {
    const rows = booked.get(vi);
    return !rows || !rows.some((r) => r.e > s && r.s < e);
  };
  const book = (vi: number, s: number, e: number): void => {
    const rows = booked.get(vi) ?? [];
    rows.push({ s, e });
    booked.set(vi, rows);
  };
  const shuffledVolunteerIndices = (): number[] => {
    const a = volunteers.map((_, i) => i);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  };

  const spotEvents: SpotEvent[] = [];
  const fullStories: FullShiftStory[] = [];
  let spotClaimCount = 0;
  let waitlistClaimCount = 0;

  for (const spec of SHIFTS) {
    const project = PROJECTS[spec.p];
    const projectId = projectIds[spec.p];
    const startsAt =
      spec.day === 0 ? base0 + spec.hour * 2 * HOUR : dayStart + spec.day * DAY + spec.hour * HOUR;
    const endsAt = startsAt + spec.durH * HOUR;
    // No clock time in the title: the server cannot know the viewer's timezone, so a
    // UTC "1pm" here would contradict the card's localized <time> for anyone outside UTC.
    const title = spec.phrase;

    const shiftId = await ctx.db.insert("shifts", {
      projectId,
      title,
      role: spec.role,
      startsAt,
      endsAt,
      capacity: spec.capacity,
      filledCount: 0,
      waitlistCount: 0,
      waitlistSeq: 0,
      status: "open",
      meetPoint: project.meetPoint,
      bring: project.bring,
      skillTag: project.skillTag,
      lastChangeAt: now,
      lastChangeKind: "seeded",
      lastChangeActorName: project.orgName,
      lastChangeIsSim: true,
      lastHumanTouchAt: 0, // nobody human has touched a fresh seed, so the pulse may move it at once
      isSeed: true,
      communityId,
    });

    const order = shuffledVolunteerIndices();
    const picked: number[] = [];
    for (const vi of order) {
      if (picked.length >= spec.filled) break;
      if (isFree(vi, startsAt, endsAt)) picked.push(vi);
    }
    // Safety net only — with 24 neighbors and this schedule the loop above always reaches `filled`.
    // Exact counts matter more than the overlap nicety, so we fill rather than under-seed.
    for (const vi of order) {
      if (picked.length >= spec.filled) break;
      if (!picked.includes(vi)) picked.push(vi);
    }

    for (let position = 0; position < picked.length; position++) {
      const vol = volunteers[picked[position]];
      await ctx.db.insert("claims", {
        shiftId,
        projectId,
        volunteerId: vol.id,
        kind: "spot",
        position,
        startsAt,
        endsAt,
        isSeed: true,
        createdAt: now - Math.floor(600_000 + rng() * 40 * HOUR),
      });
      book(picked[position], startsAt, endsAt);
      spotEvents.push({
        shiftId,
        projectId,
        volunteerId: vol.id,
        handle: vol.handle,
        title,
        leftAfter: spec.capacity - (position + 1),
      });
    }

    const waiters: Array<{ volunteerId: Id<"volunteers">; handle: string; rank: number }> = [];
    if (spec.waitlist > 0) {
      const waiterIndices = order.filter((vi) => !picked.includes(vi)).slice(0, spec.waitlist);
      for (let k = 0; k < waiterIndices.length; k++) {
        const vol = volunteers[waiterIndices[k]];
        await ctx.db.insert("claims", {
          shiftId,
          projectId,
          volunteerId: vol.id,
          kind: "waitlist",
          // Strictly increasing => FIFO by ascending position. waitlistSeq below is recomputed to
          // sit above every one of these, so the next joiner cannot collide with a seeded waiter.
          position: k,
          startsAt,
          endsAt,
          isSeed: true,
          createdAt: now - Math.floor(600_000 + rng() * 6 * HOUR),
        });
        waiters.push({ volunteerId: vol.id, handle: vol.handle, rank: k + 1 });
      }
    }

    // COUNTERS ARE RECOUNTED FROM THE CLAIMS INDEX — never from spec.filled, never guessed.
    const spots = await readSpotClaims(ctx, shiftId);
    const wl = await readWaitlist(ctx, shiftId);
    const waitlistSeq = wl.reduce((max, c) => Math.max(max, c.position + 1), 0);
    spotClaimCount += spots.length;
    waitlistClaimCount += wl.length;

    const lastSpotHandle =
      picked.length > 0 ? volunteers[picked[picked.length - 1]].handle : project.orgName;
    const changeKind: ChangeKind =
      wl.length > 0 ? "waitlisted" : spots.length > 0 ? "claimed" : "seeded";
    const actorName =
      wl.length > 0
        ? waiters[waiters.length - 1].handle
        : spots.length > 0
          ? lastSpotHandle
          : project.orgName;

    await ctx.db.patch(shiftId, {
      filledCount: spots.length,
      waitlistCount: wl.length,
      waitlistSeq,
      lastChangeAt: now - Math.floor(120_000 + rng() * REANCHOR_WINDOW_MS),
      lastChangeKind: changeKind,
      lastChangeActorName: actorName,
      lastChangeIsSim: true,
    });

    if (spec.waitlist > 0 && waiters.length > 0) {
      // Builds an honest history for a full shift: it filled, somebody who is NOT on it now
      // released, the then-head of the waitlist (a current spot holder) took the seat, and the
      // three people on the waitlist today queued up after that.
      const waiterIds = new Set(waiters.map((w) => w.volunteerId));
      const releaserIdx =
        order.find((vi) => !picked.includes(vi) && !waiterIds.has(volunteers[vi].id)) ?? order[0];
      const releaser = volunteers[releaserIdx];
      const promoted = volunteers[picked[picked.length - 1]];
      fullStories.push({
        shiftId,
        projectId,
        title,
        releaserId: releaser.id,
        releaserHandle: releaser.handle,
        promotedId: promoted.id,
        promotedHandle: promoted.handle,
        waiters,
      });
    }
  }

  // --- backdated activity ---------------------------------------------------------------------
  // Backdated so the Live feed is already scrollable on FIRST PAINT rather than showing an empty
  // state. Inserted directly, not through logActivity, because logActivity stamps Date.now() and
  // backdating is the entire point.
  const offsets = irregularOffsets(ACTIVITY_ROWS, rng, REANCHOR_WINDOW_MS);

  // Claim rows come from shifts with no scripted history, so a "— 0 left" line can never sit next
  // to the filled/released/promoted story of the same shift and contradict it.
  const storyShiftIds = new Set(fullStories.map((s) => s.shiftId));
  const claimPool = spotEvents
    .map((_, i) => i)
    .filter((i) => !storyShiftIds.has(spotEvents[i].shiftId));
  for (let i = claimPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = claimPool[i];
    claimPool[i] = claimPool[j];
    claimPool[j] = tmp;
  }
  let poolAt = 0;
  const claimRow = (): FeedRow => {
    const e = spotEvents[claimPool[poolAt % claimPool.length]];
    poolAt++;
    return {
      kind: "claimed",
      projectId: e.projectId,
      shiftId: e.shiftId,
      volunteerId: e.volunteerId,
      actorName: e.handle,
      // Same wording applyClaim uses, and `leftAfter` is what was left at that moment.
      message: `${e.handle} took a spot at ${e.title} — ${e.leftAfter} left`,
    };
  };

  /** Newest-first: [waiter3, waiter2, waiter1, promoted, released, filled]. */
  const storyRows = (s: FullShiftStory): FeedRow[] => [
    ...[...s.waiters].reverse().map(
      (w): FeedRow => ({
        kind: "waitlisted",
        projectId: s.projectId,
        shiftId: s.shiftId,
        volunteerId: w.volunteerId,
        actorName: w.handle,
        message: `${w.handle} joined the waitlist for ${s.title} (#${w.rank})`,
      }),
    ),
    {
      kind: "promoted",
      projectId: s.projectId,
      shiftId: s.shiftId,
      volunteerId: s.promotedId,
      actorName: s.promotedHandle,
      message: `${s.promotedHandle} moved off the waitlist into ${s.title}`,
    },
    {
      kind: "released",
      projectId: s.projectId,
      shiftId: s.shiftId,
      volunteerId: s.releaserId,
      actorName: s.releaserHandle,
      message: `${s.releaserHandle} released a spot at ${s.title}`,
    },
    {
      kind: "filled",
      projectId: s.projectId,
      shiftId: s.shiftId,
      // The neighbor who took the last spot back then is the one who later released it.
      actorName: s.releaserHandle,
      message: `${s.title} is full — waitlist open`,
    },
  ];

  const rows: FeedRow[] = [];
  for (let i = 0; i < 8; i++) rows.push(claimRow());
  if (fullStories.length > 1) {
    const [w3, w2, w1, promoted, released, filled] = storyRows(fullStories[1]);
    rows.push(w3);
    for (let i = 0; i < 3; i++) rows.push(claimRow());
    rows.push(w2, w1, promoted, released, filled);
  }
  for (let i = 0; i < 5; i++) rows.push(claimRow());
  if (spotEvents.length > 0) {
    const cap = spotEvents[Math.floor(rng() * spotEvents.length)];
    rows.push({
      kind: "capacity_added",
      projectId: cap.projectId,
      shiftId: cap.shiftId,
      volunteerId: cap.volunteerId,
      actorName: cap.handle,
      message: `${cap.handle} opened 2 more spots at ${cap.title}`,
    });
  }
  if (fullStories.length > 0) {
    const [w3, w2, w1, promoted, released, filled] = storyRows(fullStories[0]);
    rows.push(w3);
    for (let i = 0; i < 3; i++) rows.push(claimRow());
    rows.push(w2, w1, promoted, released, filled);
  }
  while (rows.length < ACTIVITY_ROWS) rows.push(claimRow());

  const feedCount = Math.min(rows.length, offsets.length);
  for (let i = 0; i < feedCount; i++) {
    const row = rows[i];
    await ctx.db.insert("activity", {
      kind: row.kind,
      projectId: row.projectId,
      shiftId: row.shiftId,
      ...(row.volunteerId ? { volunteerId: row.volunteerId } : {}),
      actorName: row.actorName,
      message: row.message,
      isSim: true,
      createdAt: now - offsets[i],
      communityId,
    });
  }

  return {
    projects: projectIds.length,
    shifts: SHIFTS.length,
    volunteers: volunteers.length,
    spotClaims: spotClaimCount,
    waitlistClaims: waitlistClaimCount,
    activity: feedCount,
  };
}

async function reseed(ctx: MutationCtx): Promise<SeedStats> {
  await wipeSeeded(ctx);
  const stats = await writeDataset(ctx);
  const now = Date.now();
  const main = await ctx.db
    .query("meta")
    .withIndex("by_key", (q) => q.eq("key", "main"))
    .unique();
  const fields = {
    key: "main",
    seedVersion: SEED_VERSION,
    pulseEnabled: true,
    pulseRunning: false,
    pulseToken: "",
    lastPulseAt: 0,
    lastSeededAt: now,
  };
  if (main) {
    await ctx.db.patch(main._id, fields);
  } else {
    await ctx.db.insert("meta", fields);
  }
  return stats;
}

const statsReturn = v.object({
  seeded: v.boolean(),
  projects: v.number(),
  shifts: v.number(),
  volunteers: v.number(),
  spotClaims: v.number(),
  waitlistClaims: v.number(),
  activity: v.number(),
});

const EMPTY_STATS: SeedStats = {
  projects: 0,
  shifts: 0,
  volunteers: 0,
  spotClaims: 0,
  waitlistClaims: 0,
  activity: 0,
};

/**
 * INTERNAL. Idempotent on meta.seedVersion: the current version plus at least one shift means the
 * board is already good and nothing is touched. Runs at deploy and lazily from volunteers.ensure,
 * so a wiped or never-seeded deployment repairs itself before anyone sees an empty board.
 */
export const ensure = internalMutation({
  args: {},
  returns: statsReturn,
  handler: async (ctx) => {
    const main = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", "main"))
      .unique();
    const existingShift = await ctx.db.query("shifts").take(1);
    if (main && main.seedVersion === SEED_VERSION && existingShift.length > 0) {
      return { seeded: false, ...EMPTY_STATS };
    }
    const stats = await reseed(ctx);
    return { seeded: true, ...stats };
  },
});

/**
 * INTERNAL (daily 09:00 UTC cron). Advances every seeded shift that has already ended by whole days
 * and patches the denormalized startsAt/endsAt of each of its claims in the same transaction — this
 * is the ONLY writer of shift times, and by_volunteer_starts (hence applyClaim's time-overlap
 * check) stays honest only because it does that. Seeded activity is re-anchored into the last three
 * hours so the feed never reads "4 days ago" on judging day. Empty board => full reseed.
 */
export const rollForward = internalMutation({
  args: {},
  returns: v.object({
    reseeded: v.boolean(),
    shiftsRolled: v.number(),
    claimsPatched: v.number(),
    activityReanchored: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();

    const anyShift = await ctx.db.query("shifts").take(1);
    if (anyShift.length === 0) {
      await reseed(ctx);
      return { reseeded: true, shiftsRolled: 0, claimsPatched: 0, activityReanchored: 0 };
    }

    const rng = mulberry32(hashString(`crewcall:roll:${Math.floor(now / DAY)}`));

    // Anything that has ended also started in the past, so this range cannot miss a stale shift.
    const past = await ctx.db
      .query("shifts")
      .withIndex("by_start", (q) => q.lt("startsAt", now))
      .collect();

    let shiftsRolled = 0;
    let claimsPatched = 0;
    for (const shift of past) {
      if (!shift.isSeed || shift.endsAt >= now) continue;
      const days = Math.ceil((now - shift.startsAt) / DAY);
      const delta = days * DAY;
      const startsAt = shift.startsAt + delta;
      const endsAt = shift.endsAt + delta;
      await ctx.db.patch(shift._id, {
        startsAt,
        endsAt,
        // The card's attribution chip is re-anchored with the feed it agrees with.
        lastChangeAt: now - Math.floor(120_000 + rng() * REANCHOR_WINDOW_MS),
      });
      const claims = await ctx.db
        .query("claims")
        .withIndex("by_shift_kind_position", (q) => q.eq("shiftId", shift._id))
        .collect();
      for (const claim of claims) {
        if (!claim.isSeed) {
          // A real person signed up for the shift that just ENDED. Carrying their claim a day
          // forward would silently book them onto a slot they never chose (and could overlap
          // another commitment), so it is dropped rather than moved.
          await ctx.db.delete(claim._id);
          continue;
        }
        await ctx.db.patch(claim._id, { startsAt, endsAt });
        claimsPatched++;
      }
      // Counters are always recomputed from the index, never adjusted by arithmetic.
      const spotsLeft = await ctx.db
        .query("claims")
        .withIndex("by_shift_kind_position", (q) => q.eq("shiftId", shift._id).eq("kind", "spot"))
        .collect();
      const waitingLeft = await ctx.db
        .query("claims")
        .withIndex("by_shift_kind_position", (q) =>
          q.eq("shiftId", shift._id).eq("kind", "waitlist"),
        )
        .collect();
      await ctx.db.patch(shift._id, {
        filledCount: spotsLeft.length,
        waitlistCount: waitingLeft.length,
      });
      shiftsRolled++;
    }

    // Re-anchor the simulated ticker into the last 3 hours, preserving relative order.
    const feed = await ctx.db.query("activity").withIndex("by_created").order("asc").take(300);
    const stale = feed.filter((row) => row.isSim && row.createdAt < now - REANCHOR_WINDOW_MS);
    if (stale.length > 0) {
      const offsets = irregularOffsets(stale.length, rng, REANCHOR_WINDOW_MS);
      for (let i = 0; i < stale.length; i++) {
        // stale[0] is the oldest row, so it keeps the largest offset (the oldest new timestamp).
        await ctx.db.patch(stale[i]._id, { createdAt: now - offsets[stale.length - 1 - i] });
      }
    }

    return {
      reseeded: false,
      shiftsRolled,
      claimsPatched,
      activityReanchored: stale.length,
    };
  },
});
