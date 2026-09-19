import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError, Value } from "convex/values";
import { DataModel } from "./_generated/dataModel";
import { normalizeUsername, sanitizeHandle } from "./lib";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/**
 * USERNAME + password, no email, no PII.
 *
 * The Password provider uses `profile.email` as the ACCOUNT ID. We deliberately store the
 * normalized USERNAME in that field. It is not an email address, is never displayed as
 * `users.email`, and must not be "fixed" into a real email field — doing so would change every
 * account id and lock existing users out.
 */
function usernameProfile(params: Record<string, Value | undefined>) {
  const raw = typeof params.username === "string" ? params.username : "";
  const username = normalizeUsername(raw);
  if (!USERNAME_RE.test(username)) {
    throw new ConvexError({
      code: "BAD_INPUT",
      message: "Usernames are 3–20 letters, numbers or _.",
    });
  }
  const displayName =
    typeof params.name === "string" && params.name.trim().length > 0
      ? sanitizeHandle(params.name)
      : username;
  return { email: username, name: displayName };
}

function validatePasswordRequirements(password: string): void {
  if (
    typeof password !== "string" ||
    password.length < PASSWORD_MIN ||
    password.length > PASSWORD_MAX
  ) {
    throw new ConvexError({
      code: "BAD_INPUT",
      message: "Passwords need at least 8 characters.",
    });
  }
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password<DataModel>({ id: "password", profile: usernameProfile, validatePasswordRequirements }),
  ],
});
