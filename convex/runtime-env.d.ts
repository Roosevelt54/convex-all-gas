// Convex's V8 runtime exposes deployment environment variables on process.env, but these
// functions do NOT run in Node, so the full Node type definitions would wrongly allow Node-only
// APIs. Declare exactly what exists. (Two dots in the filename: Convex's bundler skips it.)
declare const process: { readonly env: Record<string, string | undefined> };
