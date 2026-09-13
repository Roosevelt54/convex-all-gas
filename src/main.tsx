import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";

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
  createRoot(rootEl).render(
    <StrictMode>
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </StrictMode>,
  );
}
