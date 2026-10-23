import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// ---------- window.storage Polyfill (ersetzt Claudes Artifact-Speicher-API) ----------
// Gleiche Schnittstelle wie im Claude-Artifact (get/set/delete/list, async). Nutzt den
// gemeinsamen Online-Speicher (/api/storage, Upstash Redis).
//
// Sicherheitsnetz gegen Datenverlust:
//  - Jede Änderung wird ZUERST lokal im Browser gespeichert (sofort, auch wenn die Seite
//    gleich geschlossen wird) und als "noch nicht in der Cloud bestätigt" markiert.
//  - Erst wenn die Cloud den Schreibvorgang bestätigt, wird die Markierung entfernt.
//  - Beim Lesen gewinnt ein unbestätigter lokaler Stand gegenüber der Cloud, und die
//    Übertragung wird erneut versucht (beim Start, bei Internet-Rückkehr, beim Zurückkehren
//    in die App).
//  - Schreibvorgänge pro Schlüssel laufen nacheinander, damit ein älterer Stand nie einen
//    neueren überholt.
//  - Schlägt die Cloud fehl, erscheint ein sichtbarer Hinweis statt stillem Weitermachen.
const PREFIX = "brick-sorter:";
const PENDING = "brick-sorter-pending:";

function lsGet(k) {
  try {
    return localStorage.getItem(k);
  } catch (e) {
    return null;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch (e) {
    return false;
  }
}
function lsDel(k) {
  try {
    localStorage.removeItem(k);
  } catch (e) {}
}

// ---------- sichtbarer Hinweis bei Cloud-Problemen ----------
let bannerEl = null;
function showBanner(text) {
  try {
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.style.cssText =
        "position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#e0a72d;color:#1a1300;" +
        "font:600 12px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:8px;text-align:center;";
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = text;
    bannerEl.style.display = "block";
  } catch (e) {}
}
function hideBanner() {
  if (bannerEl) bannerEl.style.display = "none";
}

// ---------- Schreib-Warteschlange pro Schlüssel ----------
const chains = {};

async function pushToCloud(key) {
  const value = lsGet(PREFIX + key);
  if (value === null) return true;
  // keepalive hilft kleinen Schreibvorgängen, auch beim Schließen der Seite noch anzukommen
  const res = await fetch("/api/storage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
    keepalive: value.length < 50000,
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "Speicher-Fehler");
  // Nur bestätigen, wenn sich der lokale Stand zwischenzeitlich nicht erneut geändert hat
  if (lsGet(PREFIX + key) === value) lsDel(PENDING + key);
  return true;
}

function schedulePush(key) {
  const prev = chains[key] || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => pushToCloud(key))
    .then(() => {
      if (pendingKeys().length === 0) hideBanner();
    })
    .catch(() => {
      showBanner("Cloud-Speicherung gerade nicht möglich – deine Änderungen sind lokal gesichert und werden später übertragen.");
    });
  chains[key] = next;
  return next;
}

function pendingKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PENDING)) keys.push(k.slice(PENDING.length));
    }
  } catch (e) {}
  return keys;
}

function flushPending() {
  pendingKeys().forEach((k) => schedulePush(k));
}

window.addEventListener("online", flushPending);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") flushPending();
});

window.storage = {
  async get(key) {
    // Unbestätigter lokaler Stand hat Vorrang vor der Cloud (sonst gehen Änderungen verloren)
    if (lsGet(PENDING + key) !== null) {
      const local = lsGet(PREFIX + key);
      if (local !== null) {
        schedulePush(key);
        return { key, value: local, shared: false };
      }
    }
    try {
      const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Speicher-Fehler");
      if (data.value === null || data.value === undefined) return null;
      return { key, value: data.value, shared: true };
    } catch (e) {
      const local = lsGet(PREFIX + key);
      return local === null ? null : { key, value: local, shared: false };
    }
  },
  async set(key, value) {
    const stored = lsSet(PREFIX + key, value);
    if (stored) lsSet(PENDING + key, "1");
    if (!stored) {
      // Lokaler Speicher voll (sehr große Daten) - dann direkt und ohne Netz-Sicherung senden
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
        showBanner("Speichern fehlgeschlagen (Daten zu groß für lokalen Speicher und Cloud nicht erreichbar).");
        return { key, value, shared: false };
      }
    }
    await schedulePush(key);
    return { key, value, shared: lsGet(PENDING + key) === null };
  },
  async delete(key) {
    lsDel(PENDING + key);
    lsDel(PREFIX + key);
    try {
      const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Speicher-Fehler");
      return { key, deleted: !!data.deleted, shared: true };
    } catch (e) {
      return { key, deleted: false, shared: false };
    }
  },
  async list() {
    // Wird von der App aktuell nicht genutzt.
    return { keys: [], shared: true };
  },
};

// Beim Start noch offene Übertragungen nachholen
flushPending();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
