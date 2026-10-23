import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// ---------- window.storage Polyfill (ersetzt Claudes Artifact-Speicher-API) ----------
// Gleiche Schnittstelle wie im Claude-Artifact (get/set/delete/list, async).
//
// Speicherort: IndexedDB direkt im Browser des Handys (kein praktisches Größenlimit, anders
// als localStorage mit ca. 5 MB oder die Cloud-Schnittstelle mit ihren Größenbegrenzungen).
// Die Cloud (Upstash) wird nicht mehr zum Speichern benutzt - nur EINMALIG beim ersten Start,
// um den bisherigen Stand ins Handy zu übernehmen. Der alte Cloud-Stand bleibt dabei
// unangetastet und dient als zusätzliche Sicherung.
//
// WICHTIG: Die Daten liegen nur in diesem Browser. Browser-Daten löschen = Daten weg.
// Deshalb regelmäßig im Zahnrad-Menü eine Sicherung herunterladen.
const PREFIX = "brick-sorter:";
const PENDING = "brick-sorter-pending:";
const DB_NAME = "brick-sorter-db";
const STORE = "kv";
const KEYS = [
  "my-sets",
  "scan-log",
  "parts-lists",
  "collected-counts",
  "parts-list-pages",
  "part-images",
  "rebrickable-api-key",
  "set-meta",
  "figures",
];

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

// ---------- sichtbarer Hinweis ----------
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

// ---------- IndexedDB ----------
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

let idbOk = true;

// ---------- einmalige Übernahme des bisherigen Standes ----------
// Pro Schlüssel: unbestätigter lokaler Stand (aus der letzten Version) > Cloud > lokale Kopie.
const ready = (async () => {
  try {
    try {
      // Bitte den Browser, die Daten nicht automatisch zu verwerfen
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) {}
    await openDb();
    if ((await idbGet("__migrated__")) === "1") return;
    let incomplete = false;
    for (const k of KEYS) {
      if ((await idbGet(k)) !== null) continue;
      const local = lsGet(PREFIX + k);
      const pending = lsGet(PENDING + k) !== null;
      let val = null;
      if (pending && local !== null) {
        val = local;
      } else {
        try {
          const res = await fetch(`/api/storage?key=${encodeURIComponent(k)}`);
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || "Speicher-Fehler");
          if (data.value !== null && data.value !== undefined) val = data.value;
        } catch (e) {
          incomplete = true;
        }
        if (val === null && local !== null) val = local;
      }
      if (val !== null) await idbSet(k, val);
    }
    if (incomplete) {
      showBanner("Übernahme der Cloud-Daten unvollständig (kein Internet?). Bitte App mit Internet neu starten, bevor du sortierst.");
    } else {
      await idbSet("__migrated__", "1");
    }
  } catch (e) {
    idbOk = false;
    showBanner("Lokaler Speicher (IndexedDB) nicht verfügbar – Änderungen werden nur eingeschränkt gesichert.");
  }
})();

window.storage = {
  async get(key) {
    await ready;
    if (idbOk) {
      try {
        const v = await idbGet(key);
        return v === null ? null : { key, value: v, shared: false };
      } catch (e) {}
    }
    const local = lsGet(PREFIX + key);
    return local === null ? null : { key, value: local, shared: false };
  },
  async set(key, value) {
    await ready;
    if (idbOk) {
      try {
        await idbSet(key, value);
        hideBanner();
        return { key, value, shared: false };
      } catch (e) {
        showBanner("Speichern fehlgeschlagen – bitte jetzt eine Sicherung herunterladen!");
        throw e;
      }
    }
    if (!lsSet(PREFIX + key, value)) {
      showBanner("Speichern fehlgeschlagen (Speicher voll) – bitte eine Sicherung herunterladen!");
      throw new Error("Speicher voll");
    }
    return { key, value, shared: false };
  },
  async delete(key) {
    await ready;
    try {
      if (idbOk) await idbDel(key);
      lsDel(PREFIX + key);
      return { key, deleted: true, shared: false };
    } catch (e) {
      return { key, deleted: false, shared: false };
    }
  },
  async list() {
    // Wird von der App aktuell nicht genutzt.
    return { keys: [], shared: false };
  },
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
