import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// ---------- window.storage Polyfill (ersetzt Claudes Artifact-Speicher-API) ----------
// Gleiche Schnittstelle wie im Claude-Artifact (get/set/delete/list, async). Nutzt jetzt
// den gemeinsamen Online-Speicher (/api/storage, Upstash Redis) statt nur lokalem
// localStorage - so sehen mehrere Geräte/Nutzer denselben Stand (z.B. gleichzeitiges
// Scannen). Falls die Cloud gerade nicht erreichbar ist (z.B. Upstash noch nicht
// eingerichtet, oder kein Internet), fällt es automatisch auf lokalen Speicher zurück,
// damit die App trotzdem nutzbar bleibt.
const PREFIX = "brick-sorter:";

const localFallback = {
  get(key) {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? null : { key, value: raw, shared: false };
  },
  set(key, value) {
    localStorage.setItem(PREFIX + key, value);
    return { key, value, shared: false };
  },
  delete(key) {
    const existed = localStorage.getItem(PREFIX + key) !== null;
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: existed, shared: false };
  },
};

window.storage = {
  async get(key) {
    try {
      const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Speicher-Fehler");
      if (data.value === null || data.value === undefined) return null;
      return { key, value: data.value, shared: true };
    } catch (e) {
      return localFallback.get(key);
    }
  },
  async set(key, value) {
    try {
      const res = await fetch("/api/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Speicher-Fehler");
      return { key, value, shared: true };
    } catch (e) {
      return localFallback.set(key, value);
    }
  },
  async delete(key) {
    try {
      const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Speicher-Fehler");
      return { key, deleted: !!data.deleted, shared: true };
    } catch (e) {
      return localFallback.delete(key);
    }
  },
  async list() {
    // Wird von der App aktuell nicht genutzt.
    return { keys: [], shared: true };
  },
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
