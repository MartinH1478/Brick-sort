import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// ---------- window.storage Polyfill (ersetzt Claudes Artifact-Speicher-API) ----------
// Gleiche Schnittstelle wie im Claude-Artifact (get/set/delete/list, async), aber
// gestützt auf normales localStorage im Browser. "shared" wird ignoriert - hier gibt es
// nur ein Gerät, keinen Mehrbenutzer-Speicher.
const PREFIX = "brick-sorter:";

window.storage = {
  async get(key) {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    return { key, value: raw, shared: false };
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    const existed = localStorage.getItem(PREFIX + key) !== null;
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: existed, shared: false };
  },
  async list(prefix) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        const bare = k.slice(PREFIX.length);
        if (!prefix || bare.startsWith(prefix)) keys.push(bare);
      }
    }
    return { keys, prefix, shared: false };
  },
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
