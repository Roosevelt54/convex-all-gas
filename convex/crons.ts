import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Decay "N neighbors here now" by WRITING isActive:false. A presence query never compares
// lastPingAt to Date.now(), so this write is what invalidates those subscriptions.
crons.interval("presence sweep", { seconds: 20 }, internal.presence.sweep, {});

// The pulse chain can never die permanently — but the watchdog only restarts it while
// somebody is actually present, and it also keeps the activity ticker bounded.
crons.interval("pulse watchdog", { seconds: 60 }, internal.sim.watchdog, {});

// Seeded shifts walk forward whole days so the board can never read as abandoned.
crons.daily("seed roll forward", { hourUTC: 9, minuteUTC: 0 }, internal.seed.rollForward, {});

export default crons;
