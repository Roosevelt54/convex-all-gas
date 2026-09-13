import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// The static site owns the root of *.convex.site; any app HTTP routes live under /api.
// Without the "/" mount the component serves nothing at the root and the site 404s.
const app = defineApp({ httpPrefix: "/api" });
app.use(staticHosting, { httpPrefix: "/" });

export default app;
