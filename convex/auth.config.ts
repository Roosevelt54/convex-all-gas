// Convex Auth issues its own JWTs from this deployment's site URL. Without this file (or with a
// wrong domain) every request is silently treated as signed out.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
