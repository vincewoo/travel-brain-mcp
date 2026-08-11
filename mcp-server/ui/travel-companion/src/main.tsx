import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Registration is best-effort: the app works without a worker, it just will not open offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {
      /* An unavailable worker is not worth interrupting the traveller over. */
    });
  });
}
