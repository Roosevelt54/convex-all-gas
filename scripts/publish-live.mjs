// Publish Crewcall to the live site judges use.
//
// Day-to-day development runs against a PRIVATE local backend (`npm run dev`), so nothing you
// try while building can reach the live site by accident. This script is the only path to it:
// it pushes the backend, then builds and uploads the frontend, both pinned to the live
// deployment below. It refuses to run without --yes.
//
//   npm run publish:live -- --yes

import { spawnSync } from "node:child_process";

const LIVE_DEPLOYMENT = "dev:quaint-ermine-433";
const LIVE_SITE = "https://quaint-ermine-433.convex.site";

if (!process.argv.includes("--yes")) {
  console.error(
    `This publishes to the LIVE site (${LIVE_SITE}).\n` +
      "Re-run with --yes when you mean it:  npm run publish:live -- --yes",
  );
  process.exit(1);
}

// CONVEX_DEPLOYMENT in the process environment takes precedence over .env.local, so every child
// command below targets the live deployment regardless of what local development is pointed at.
const env = { ...process.env, CONVEX_DEPLOYMENT: LIVE_DEPLOYMENT };
delete env.CONVEX_URL;
delete env.CONVEX_SITE_URL;
delete env.VITE_CONVEX_URL;

function run(label, args) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`✖ ${label} failed (exit ${r.status}). The live site was not fully updated.`);
    process.exit(r.status ?? 1);
  }
}

run("Push backend to the live deployment", ["convex", "dev", "--once", "--typecheck", "enable"]);
run("Build and upload the frontend", ["@convex-dev/static-hosting", "upload", "--build"]);

console.log(`\n✔ Published. Check it: ${LIVE_SITE}`);
