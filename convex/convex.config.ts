import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// No httpPrefix on either: root routing is owned by convex/http.ts, which registers Convex Auth's
// /.well-known routes first and the static-hosting catch-all last. Mounting the component at "/"
// here instead would shadow the auth routes and every sign-in would fail JWT validation.
const app = defineApp();
app.use(staticHosting);

export default app;
