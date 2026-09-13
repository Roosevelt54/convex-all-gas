# Hackathon log

- **Project:** Crewcall
- **Event:** Convex All Gas Hackathon
- **What it does:** A real-time volunteer shift board where neighbors claim spots on community projects, join a FIFO waitlist when a shift is full, and get promoted automatically when someone releases.
- **Live app:** not deployed
- **Repo:** https://github.com/Roosevelt54/convex-all-gas
- **Frontend:** Convex static hosting
- **Convex deployment:** not deployed
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, indexes, queries, mutations, scheduled functions, crons, realtime queries, paginated queries, optimistic updates
- **Auth:** none
- **AI models:** none
- **Started:** 2026-09-11T22:41:07Z
- **Last updated:** 2026-09-13T11:38:16Z

## Log

### 2026-09-11 - 699508a
Initialized an empty repository and set up the build environment. Installed the
official Convex plugin for Claude Code and the hackathon build-log skill under
`.claude/skills/convex-hackathon-skill/`. No application code, manifest, or
Convex configuration exists yet, so every product field above is recorded as
absent rather than assumed. Frontend host chosen as Convex static hosting; the
component is not installed yet because there is no Convex app to attach it to.

### 2026-09-13 - working tree
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
