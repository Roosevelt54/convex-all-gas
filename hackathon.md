# Hackathon log

- **Project:** Crewcall
- **Event:** Convex All Gas Hackathon
- **What it does:** A real-time volunteer shift board where neighbors claim spots on community projects, join a FIFO waitlist when a shift is full, and get promoted automatically when someone releases.
- **Live app:** https://quaint-ermine-433.convex.site
- **Repo:** https://github.com/Roosevelt54/convex-all-gas
- **Frontend:** Convex static hosting
- **Convex deployment:** https://quaint-ermine-433.convex.cloud
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, indexes, queries, mutations, scheduled functions, crons, realtime queries, paginated queries, optimistic updates
- **Auth:** none
- **AI models:** none
- **Started:** 2026-09-11T22:41:07Z
- **Last updated:** 2026-09-17T18:12:47Z

## Log

### 2026-09-11 - 699508a
Initialized an empty repository and set up the build environment. Installed the
official Convex plugin for Claude Code and the hackathon build-log skill under
`.claude/skills/convex-hackathon-skill/`. No application code, manifest, or
Convex configuration exists yet, so every product field above is recorded as
absent rather than assumed. Frontend host chosen as Convex static hosting; the
component is not installed yet because there is no Convex app to attach it to.

### 2026-09-13 - 81f9b35
Built Crewcall: a live shift board, a focus-trapped shift sheet, and a read-only wall
display. Claiming a spot re-reads every spot claim for the shift inside one transaction, so
concurrent claims cannot double-book; a local test fires 8 simultaneous claims at the last
spot and gets exactly 1 winner and 7 FIFO waitlist places. Releasing promotes the head of the
waitlist into the vacated spot in the same transaction. A presence-gated "community pulse"
(scheduled functions) claims and releases as seeded neighbors, labelled `sim`, and stops
when nobody is watching; crons sweep presence and roll seeded shifts forward daily. Identity
is a device-scoped key, not an auth provider. Verified locally against an anonymous local
deployment only; nothing is deployed. Convex features: schema, indexes, queries, mutations,
scheduled functions, crons, realtime queries, paginated queries, optimistic updates
(`convex/schema.ts`, `convex/lib.ts`, `convex/shifts.ts`, `convex/sim.ts`, `convex/crons.ts`,
`src/components/Board.tsx`, `src/components/ShiftSheet.tsx`, `tests/race.mjs`).

### 2026-09-17 - working tree
Moved from the anonymous local backend to a Convex cloud project and published the site with
Convex static hosting, which now owns the site root while app HTTP routes sit under `/api`
(`convex/convex.config.ts`). The live app loads with seeded data, the community pulse changes
counters with no input, and a claim in one window moved the wall display's spots-left count in a
second window without a reload. The race test passes against the cloud backend: 8 concurrent
claims at the last spot, 1 winner, 7 waitlisted. Bumped the seed version so the deployment
reseeds cleanly without test leftovers (`convex/seed.ts`).
