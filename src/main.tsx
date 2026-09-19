import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { wantsFreshIdentity } from "./identity";

const address = import.meta.env.VITE_CONVEX_URL as string | undefined;

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root");

if (!address) {
  // Fail loudly and legibly rather than rendering a blank page: an unset
  // VITE_CONVEX_URL is the single most likely deploy-time mistake here.
  rootEl.innerHTML =
    '<div class="noscript-note"><h1>Not connected</h1>' +
    "<p>VITE_CONVEX_URL is not set, so the board has no backend to subscribe to. " +
    "Run <code>npx convex dev</code> and rebuild.</p></div>";
} else {
  const convex = new ConvexReactClient(address);

  // Convex Auth keeps its tokens in localStorage by default, which every tab on this origin
  // shares. The race-test window (#…?as=new) exists to be a DIFFERENT person on the same laptop,
  // so it must not inherit the main window's login: it keeps its tokens in this tab's own
  // sessionStorage under a separate namespace. It starts signed out, and signing in or out there
  // never touches the main window's session.
  const raceWindow = wantsFreshIdentity();

  createRoot(rootEl).render(
    <StrictMode>
      {raceWindow ? (
        <ConvexAuthProvider
          client={convex}
          storage={window.sessionStorage}
          storageNamespace="crewcall-race"
        >
          <App />
        </ConvexAuthProvider>
      ) : (
        <ConvexAuthProvider client={convex}>
          <App />
        </ConvexAuthProvider>
      )}
    </StrictMode>,
  );
}
