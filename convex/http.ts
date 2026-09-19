import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
import { auth } from "./auth";

// App-owned root routing: Convex Auth's /.well-known/openid-configuration and
// /.well-known/jwks.json must live at the site root (the JWT issuer), so this router owns "/".
const http = httpRouter();
auth.addHttpRoutes(http); // exact routes first
registerStaticRoutes(http, components.staticHosting); // static catch-all last
export default http;
