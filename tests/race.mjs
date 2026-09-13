// Adversarial concurrency test for the Crewcall claim path.
//
// The app's headline claim is "never double-booked". This fires N genuinely
// concurrent claims at a shift with exactly 1 free spot and asserts that the
// serializable read of by_shift_kind_position plus Convex OCC lets exactly one win.
//
// Runs against the LOCAL anonymous deployment only.

import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";

const env = readFileSync(process.argv[2], "utf8");
const url = /CONVEX_URL=(.*)/.exec(env)?.[1]?.trim();
if (!url) throw new Error("no CONVEX_URL in .env.local");

const client = new ConvexHttpClient(url);
const fn = (name) => name; // function references are plain strings over HTTP

function fresh(n) {
  return `racetest-${process.pid}-${n}-${Math.random().toString(36).slice(2, 10)}`;
}

const fail = [];
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) fail.push(label);
}

const CONTENDERS = 8;

// --- find a shift with exactly one spot left -------------------------------
const snap = await client.query(fn("board:snapshot"), {});
const target = snap.shifts.find((s) => s.capacity - s.filledCount === 1 && s.status === "open");
if (!target) throw new Error("no shift with exactly 1 spot left; re-seed first");

console.log(
  `\ntarget: "${target.title}"  capacity=${target.capacity} filled=${target.filledCount} waitlist=${target.waitlistCount}`,
);
console.log(`firing ${CONTENDERS} concurrent claims at 1 free spot...\n`);

// --- mint N distinct identities -------------------------------------------
const keys = Array.from({ length: CONTENDERS }, (_, i) => fresh(i));
await Promise.all(keys.map((k) => client.mutation(fn("volunteers:ensure"), { deviceKey: k })));

// --- fire them all at once -------------------------------------------------
const settled = await Promise.allSettled(
  keys.map((k) => client.mutation(fn("shifts:claim"), { deviceKey: k, shiftId: target._id })),
);

const ok = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
const threw = settled.filter((r) => r.status === "rejected");
const claimed = ok.filter((r) => r.outcome === "claimed");
const waitlisted = ok.filter((r) => r.outcome === "waitlisted");
const other = ok.filter((r) => !["claimed", "waitlisted"].includes(r.outcome));

console.log(
  `outcomes: claimed=${claimed.length} waitlisted=${waitlisted.length} other=${other.length} threw=${threw.length}`,
);
if (threw.length) console.log("  first error:", String(threw[0].reason?.message).slice(0, 200));
if (other.length) console.log("  other outcomes:", JSON.stringify(other.map((o) => o.outcome)));

check("exactly ONE contender got the last spot", claimed.length === 1, `got ${claimed.length}`);
check(
  "every other contender was waitlisted, not errored",
  waitlisted.length === CONTENDERS - 1,
  `got ${waitlisted.length}/${CONTENDERS - 1}`,
);
check("no contender crashed", threw.length === 0, `${threw.length} threw`);

// --- verify persisted state ------------------------------------------------
const after = await client.query(fn("board:snapshot"), {});
const t2 = after.shifts.find((s) => s._id === target._id);

check("filledCount === capacity (shift is now full)", t2.filledCount === t2.capacity, `${t2.filledCount}/${t2.capacity}`);
check("filledCount never EXCEEDS capacity", t2.filledCount <= t2.capacity, `${t2.filledCount} vs ${t2.capacity}`);
check(
  "waitlistCount grew by exactly the losers",
  t2.waitlistCount === target.waitlistCount + (CONTENDERS - 1),
  `${target.waitlistCount} -> ${t2.waitlistCount}`,
);

// --- the winner's spot is genuinely unique --------------------------------
const detail = await client.query(fn("shifts:detail"), {
  shiftId: target._id,
  deviceKey: keys[0],
});
const positions = detail.roster.filter((r) => r.handle).map((r) => r.position);
check(
  "every roster position is distinct (no double-booking)",
  new Set(positions).size === positions.length,
  `${positions.length} rows, ${new Set(positions).size} distinct`,
);
check(
  "all positions within [0, capacity)",
  positions.every((p) => p >= 0 && p < t2.capacity),
  JSON.stringify(positions),
);

// --- waitlist FIFO ranks are distinct -------------------------------------
const ranks = waitlisted.map((w) => w.rank).sort((a, b) => a - b);
check("waitlist ranks are all distinct", new Set(ranks).size === ranks.length, JSON.stringify(ranks));

// --- idempotency: re-claiming returns "already", never a second row --------
const winnerIdx = settled.findIndex((r) => r.status === "fulfilled" && r.value.outcome === "claimed");
const winnerKey = keys[winnerIdx];
const again = await client.mutation(fn("shifts:claim"), { deviceKey: winnerKey, shiftId: target._id });
check("double-tap returns 'already', not a second claim", again.outcome === "already", String(again.outcome));

const after2 = await client.query(fn("board:snapshot"), {});
const t3 = after2.shifts.find((s) => s._id === target._id);
check("double-tap did not change filledCount", t3.filledCount === t2.filledCount, `${t2.filledCount} -> ${t3.filledCount}`);

// --- release promotes the FIFO head in the same transaction ---------------
const beforeRelease = t3.waitlistCount;
const rel = await client.mutation(fn("shifts:release"), { deviceKey: winnerKey, shiftId: target._id });
check("release reports a promotion", rel.outcome === "released" && rel.promoted !== null, JSON.stringify(rel));

const after3 = await client.query(fn("board:snapshot"), {});
const t4 = after3.shifts.find((s) => s._id === target._id);
check("shift stayed full after release+promote", t4.filledCount === t4.capacity, `${t4.filledCount}/${t4.capacity}`);
check("waitlist shrank by exactly one", t4.waitlistCount === beforeRelease - 1, `${beforeRelease} -> ${t4.waitlistCount}`);

console.log(`\n${fail.length === 0 ? "ALL CHECKS PASSED" : `${fail.length} CHECK(S) FAILED: ${fail.join("; ")}`}`);
process.exit(fail.length === 0 ? 0 : 1);
