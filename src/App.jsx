import React, { useState, useRef, useEffect } from "react";
import {
  Camera,
  Plus,
  X,
  Check,
  Loader2,
  Package,
  Settings,
  ChevronRight,
  ImagePlus,
  SkipForward,
  FileUp,
  ClipboardList,
  Download,
  Upload,
  Minus,
} from "lucide-react";

// ---------- Farbtokens ----------
// Basis: warmes Anthrazit + LEGO-Rot als Signalfarbe, Studs als wiederkehrendes Formmotiv
const COLORS = {
  bg: "#15171c",
  panel: "#1d2028",
  panelBorder: "#2a2e38",
  text: "#eef0f3",
  textDim: "#9aa0ac",
  accent: "#e0392d", // klassisches LEGO-Rot
  good: "#3fae6b",
  warn: "#e0a72d",
};

const STORAGE_KEY_SETS = "my-sets";
const STORAGE_KEY_LOG = "scan-log";
const STORAGE_KEY_PARTSLISTS = "parts-lists"; // { [setNum]: [{elementId, name, colorName, qty}] }
const STORAGE_KEY_COLLECTED = "collected-counts"; // { [setNum]: { [partIndex]: gesammelte Anzahl } }
const STORAGE_KEY_LIST_PAGES = "parts-list-pages"; // { [setNum]: ["<base64 jpeg>", ...] } - nur die Teileliste-Seiten, nicht die ganze Anleitung
const STORAGE_KEY_PART_IMAGES = "part-images"; // { [setNum]: ["<dataURL oder null>", ...] } - ein Bild pro Teil, Index = partsLists-Index
const STORAGE_KEY_RB_KEY = "rebrickable-api-key";
const STORAGE_KEY_SET_META = "set-meta"; // { [setNum]: { name, imgUrl } }

// Gemeinsame Farbpalette für Foto-Erkennung UND PDF-Teileliste, damit beide Seiten
// dieselben Begriffe verwenden und der Abgleich nicht an unterschiedlichen Farbnamen scheitert.
const LEGO_COLOR_PALETTE = [
  "Schwarz", "Weiß", "Hellgrau", "Dunkelgrau", "Rot", "Dunkelrot", "Blau", "Dunkelblau",
  "Hellblau", "Gelb", "Grün", "Dunkelgrün", "Limette", "Orange", "Braun", "Dunkelbraun",
  "Beige", "Rosa", "Magenta", "Lila", "Türkis", "Sandgrün", "Sandblau", "Sandgelb",
  "Transparent", "Transparent-Klar", "Gold", "Silber", "Perlgrau",
].join(", ");

function Stud({ size = 10, color = COLORS.accent }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: `inset 0 -2px 0 rgba(0,0,0,0.25), 0 1px 0 rgba(255,255,255,0.15)`,
      }}
    />
  );
}

// status je Foto: "pending" -> "analyzing" -> "reviewing" -> "done" (oder "no-part")
function makePhotoItem(id, base64) {
  return {
    id,
    // previewUrl ist die vollständige data:image/jpeg;base64,... URL - zuverlässiger als
    // createObjectURL/blob: URLs, die in der Artifact-Sandbox teils nicht rendern
    previewUrl: `data:image/jpeg;base64,${base64}`,
    base64,
    status: "pending",
    result: null,
    matchStatus: null,
    candidateSets: [],
  };
}

export default function LegoScanner() {
  const [screen, setScreen] = useState("setup"); // setup | scan | overview
  const [mySets, setMySets] = useState([]);
  const [newSetInput, setNewSetInput] = useState("");
  const [partsLists, setPartsLists] = useState({}); // { [setNum]: [{elementId, name, colorName, qty}] }
  const [collectedCounts, setCollectedCounts] = useState({}); // { [setNum]: { [partIndex]: Anzahl } }
  const [partsListPages, setPartsListPages] = useState({}); // { [setNum]: ["<base64 jpeg>", ...] }
  const [partImages, setPartImages] = useState({}); // { [setNum]: ["<dataURL oder null>", ...] } Index = partsLists-Index
  const [rebrickableKey, setRebrickableKey] = useState("");
  const [rebrickableKeyDraft, setRebrickableKeyDraft] = useState("");
  const [rebrickableLoadingFor, setRebrickableLoadingFor] = useState(null);
  const [setMeta, setSetMeta] = useState({}); // { [setNum]: { name, imgUrl } }
  const [expandedSetNum, setExpandedSetNum] = useState(null);
  const [expandedOverviewSet, setExpandedOverviewSet] = useState(null);
  const [pdfjsReady, setPdfjsReady] = useState(false);
  const [pdfjsFailed, setPdfjsFailed] = useState(false);
  const [pdfUploadingFor, setPdfUploadingFor] = useState(null); // setNum, während PDF verarbeitet wird
  const [showSettings, setShowSettings] = useState(false);
  const [log, setLog] = useState([]);
  const [toast, setToast] = useState(null);
  const [lastDebugRequest, setLastDebugRequest] = useState(null);
  const [lastDebugResponse, setLastDebugResponse] = useState(null);
  const [showDebug, setShowDebug] = useState(false);
  const [manualPickSet, setManualPickSet] = useState(null); // setNum während manueller Teilauswahl
  const [manualFilter, setManualFilter] = useState("");
  const [manualOverride, setManualOverride] = useState(false); // true = manuelle Liste zeigen, obwohl ein Treffer da ist
  const [pageNumberInputs, setPageNumberInputs] = useState({}); // { [setNum]: "12,13" } manuelle Seitenangabe

  const [photos, setPhotos] = useState([]); // Warteschlange, siehe makePhotoItem
  const processingRef = useRef(false);
  const fileInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const teilelisteImageInputRef = useRef(null);
  const pdfInputSetNumRef = useRef(null);
  const backupInputRef = useRef(null);

  // ---------- Live-Kamera-Scan (nur außerhalb der Claude-Artifact-Sandbox nutzbar) ----------
  const [liveMode, setLiveMode] = useState(false);
  const [liveScanning, setLiveScanning] = useState(false);
  const [liveAnalyzing, setLiveAnalyzing] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const videoRef = useRef(null);
  const liveCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const liveIntervalRef = useRef(null);
  const liveScanningRef = useRef(false);
  const LIVE_SCAN_INTERVAL_MS = 3000;

  // ---------- PDF.js für Seiten-Rendering nachladen (optional, mit Fallback) ----------
  useEffect(() => {
    if (window.pdfjsLib) {
      setPdfjsReady(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        setPdfjsReady(true);
      } catch (e) {
        setPdfjsFailed(true);
      }
    };
    script.onerror = () => setPdfjsFailed(true);
    document.body.appendChild(script);
  }, []);

  // Rendert bestimmte 1-indexierte Seiten einer PDF (als base64) zu JPEG-Bildern (ohne Prefix)
  async function renderPdfPagesToImages(pdfBase64, pageNumbers) {
    if (!window.pdfjsLib) return [];
    const binary = atob(pdfBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    const images = [];
    for (const pageNum of pageNumbers) {
      if (pageNum < 1 || pageNum > pdf.numPages) continue;
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", 0.75).split(",")[1]);
    }
    return images;
  }

  // ---------- Persistente Daten laden ----------
  useEffect(() => {
    (async () => {
      try {
        const s = await window.storage.get(STORAGE_KEY_SETS);
        if (s) setMySets(JSON.parse(s.value));
      } catch (e) {}
      try {
        const k = await window.storage.get(STORAGE_KEY_PARTSLISTS);
        if (k) setPartsLists(JSON.parse(k.value));
      } catch (e) {}
      try {
        const c = await window.storage.get(STORAGE_KEY_COLLECTED);
        if (c) setCollectedCounts(JSON.parse(c.value));
      } catch (e) {}
      try {
        const pg = await window.storage.get(STORAGE_KEY_LIST_PAGES);
        if (pg) setPartsListPages(JSON.parse(pg.value));
      } catch (e) {}
      try {
        const pi = await window.storage.get(STORAGE_KEY_PART_IMAGES);
        if (pi) setPartImages(JSON.parse(pi.value));
      } catch (e) {}
      try {
        const rb = await window.storage.get(STORAGE_KEY_RB_KEY);
        if (rb) {
          setRebrickableKey(rb.value);
          setRebrickableKeyDraft(rb.value);
        }
      } catch (e) {}
      try {
        const sm = await window.storage.get(STORAGE_KEY_SET_META);
        if (sm) setSetMeta(JSON.parse(sm.value));
      } catch (e) {}
      try {
        const l = await window.storage.get(STORAGE_KEY_LOG);
        if (l) setLog(JSON.parse(l.value));
      } catch (e) {}
    })();
  }, []);

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), type === "warn" ? 15000 : 2600);
  }

  async function persistSets(next) {
    setMySets(next);
    try {
      await window.storage.set(STORAGE_KEY_SETS, JSON.stringify(next));
    } catch (e) {}
  }

  async function persistLog(next) {
    setLog(next);
    try {
      await window.storage.set(STORAGE_KEY_LOG, JSON.stringify(next));
    } catch (e) {}
  }

  async function persistPartsLists(next) {
    setPartsLists(next);
    try {
      await window.storage.set(STORAGE_KEY_PARTSLISTS, JSON.stringify(next));
    } catch (e) {}
  }

  async function persistCollectedCounts(next) {
    setCollectedCounts(next);
    try {
      await window.storage.set(STORAGE_KEY_COLLECTED, JSON.stringify(next));
    } catch (e) {}
  }

  // Ein fälschlich bestätigtes Teil wieder aus der gesammelten Menge entfernen (-1).
  function decrementCollected(setNum, idx) {
    const setCounts = { ...(collectedCounts[setNum] || {}) };
    const current = setCounts[idx] || 0;
    if (current <= 0) return;
    setCounts[idx] = current - 1;
    persistCollectedCounts({ ...collectedCounts, [setNum]: setCounts });
    showToast("Zuordnung zurückgenommen", "good");
  }

  async function persistPartsListPages(next) {
    setPartsListPages(next);
    try {
      await window.storage.set(STORAGE_KEY_LIST_PAGES, JSON.stringify(next));
    } catch (e) {}
  }

  async function persistPartImages(next) {
    setPartImages(next);
    try {
      await window.storage.set(STORAGE_KEY_PART_IMAGES, JSON.stringify(next));
    } catch (e) {}
  }

  async function persistRebrickableKey(key) {
    setRebrickableKey(key);
    try {
      await window.storage.set(STORAGE_KEY_RB_KEY, key);
    } catch (e) {}
  }

  async function persistSetMeta(next) {
    setSetMeta(next);
    try {
      await window.storage.set(STORAGE_KEY_SET_META, JSON.stringify(next));
    } catch (e) {}
  }

  // Lädt Setname + Vorschaubild von Rebrickable (leichtgewichtiger Aufruf, keine Teileliste).
  async function fetchSetMeta(setNum, currentKey) {
    if (!currentKey || !currentKey.trim()) return;
    try {
      const res = await fetch(`/api/rebrickable?path=${encodeURIComponent(`/api/v3/lego/sets/${setNum}/`)}`, {
        headers: { "x-rb-key": currentKey.trim() },
      });
      const data = await res.json();
      if (!res.ok || !data.set_img_url) return;
      // Funktionales Update gegen den JEWEILS aktuellen Stand, nicht gegen einen veralteten
      // Zwischenstand aus dem Moment des Aufrufs - sonst überschreibt jedes neue Bild die
      // vorher schon geladenen (genau der Bug, den wir gerade hatten).
      setSetMeta((prev) => {
        if (prev[setNum]) return prev; // zwischenzeitlich schon geladen
        const next = { ...prev, [setNum]: { name: data.name || "", imgUrl: data.set_img_url } };
        window.storage.set(STORAGE_KEY_SET_META, JSON.stringify(next)).catch(() => {});
        return next;
      });
    } catch (e) {
      // still - Vorschaubild ist rein optional
    }
  }

  // Beim Start: für alle bereits eingetragenen Sets ohne Metadaten nachladen (nacheinander,
  // um die API nicht zu überlasten).
  useEffect(() => {
    if (!rebrickableKey.trim() || mySets.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const s of mySets) {
        if (cancelled) return;
        if (!setMeta[s]) {
          await fetchSetMeta(s, rebrickableKey);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebrickableKey, mySets.length]);

  // ---------- Teileliste direkt von Rebrickable laden (öffentliche, offizielle Datenbank) ----------
  // Umgeht die Unsicherheiten/Grenzen von KI-basierter Bild-Extraktion komplett: echte
  // Herstellerdaten inkl. offizieller Teilbilder, direkt über einen Setnummer-Abgleich.
  async function loadPartsListFromRebrickable(setNum) {
    if (!rebrickableKey.trim()) {
      showToast("Bitte zuerst einen Rebrickable-API-Key im Zahnrad-Menü eintragen", "warn");
      return;
    }
    setRebrickableLoadingFor(setNum);
    try {
      let allResults = [];
      let path = `/api/v3/lego/sets/${setNum}/parts/?page_size=1000`;
      let guard = 0;
      while (path && guard < 20) {
        guard++;
        const res = await fetch(`/api/rebrickable?path=${encodeURIComponent(path)}`, {
          headers: { "x-rb-key": rebrickableKey.trim() },
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
        }
        allResults = allResults.concat(data.results || []);
        if (data.next) {
          const u = new URL(data.next);
          path = u.pathname + u.search;
        } else {
          path = null;
        }
      }

      if (allResults.length === 0) {
        showToast(`Keine Teile für Set ${setNum} gefunden — Setnummer korrekt (inkl. '-1')?`, "warn");
        return;
      }

      const parts = allResults.map((r) => ({
        elementId: r.part?.part_num || "",
        name: r.part?.name || "",
        colorName: r.color?.name || "",
        qty: r.quantity || 0,
        imageUrl: r.part?.part_img_url || null,
      }));
      persistPartsLists({ ...partsLists, [setNum]: parts });
      showToast(`${parts.length} Teile für ${setNum} von Rebrickable geladen`, "good");
    } catch (err) {
      showToast(`Rebrickable-Fehler: ${err?.message || err}`.slice(0, 150), "warn");
    } finally {
      setRebrickableLoadingFor(null);
    }
  }

  // ---------- Sicherung: Export/Import des gesamten Fortschritts ----------
  function downloadTextFile(filename, mimeType, content) {
    const dataUri = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
    const a = document.createElement("a");
    a.href = dataUri;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function exportMissingListCsv() {
    const rows = [["Set", "Teil", "Farbe", "Element-ID", "Soll", "Gesammelt", "Fehlen"]];
    mySets
      .filter((s) => (partsLists[s] || []).length > 0)
      .forEach((setNum) => {
        const list = partsLists[setNum] || [];
        const counts = collectedCounts[setNum] || {};
        list.forEach((p, idx) => {
          const collected = counts[idx] || 0;
          const missing = Math.max(0, (p.qty || 0) - collected);
          if (missing > 0) {
            rows.push([setNum, p.name || "", p.colorName || "", p.elementId || "", p.qty || 0, collected, missing]);
          }
        });
      });
    if (rows.length === 1) {
      showToast("Keine fehlenden Teile — nichts zu exportieren");
      return;
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
    downloadTextFile(`fehlteile-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", csv);
  }

  function exportBackup() {
    const backup = {
      version: 2,
      exportedAt: new Date().toISOString(),
      mySets,
      partsLists,
      collectedCounts,
      partsListPages,
      partImages,
      log,
    };
    downloadTextFile(
      `brick-sorter-sicherung-${new Date().toISOString().slice(0, 10)}.json`,
      "application/json",
      JSON.stringify(backup)
    );
    showToast("Sicherung heruntergeladen", "good");
  }

  function triggerBackupUpload() {
    backupInputRef.current?.click();
  }

  async function handleBackupSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!backup || !Array.isArray(backup.mySets)) throw new Error("invalid");

      await persistSets(backup.mySets || []);
      await persistPartsLists(backup.partsLists || {});
      await persistCollectedCounts(backup.collectedCounts || {});
      await persistPartsListPages(backup.partsListPages || {});
      await persistPartImages(backup.partImages || {});
      await persistLog(backup.log || []);
      showToast("Sicherung geladen — weiter geht's", "good");
    } catch (e) {
      showToast("Datei konnte nicht gelesen werden — ist es eine gültige Sicherung?", "warn");
    }
  }

  function addSet() {
    const val = newSetInput.trim();
    if (!val) return;
    const normalized = val.includes("-") ? val : `${val}-1`;
    if (mySets.includes(normalized)) {
      showToast("Set ist schon in der Liste");
      return;
    }
    persistSets([...mySets, normalized]);
    setNewSetInput("");
    fetchSetMeta(normalized, rebrickableKey);
  }

  function removeSet(setNum) {
    persistSets(mySets.filter((s) => s !== setNum));
    const next = { ...partsLists };
    delete next[setNum];
    persistPartsLists(next);
    const nextPages = { ...partsListPages };
    delete nextPages[setNum];
    persistPartsListPages(nextPages);
    const nextImages = { ...partImages };
    delete nextImages[setNum];
    persistPartImages(nextImages);
    const nextMeta = { ...setMeta };
    delete nextMeta[setNum];
    persistSetMeta(nextMeta);
    if (expandedSetNum === setNum) setExpandedSetNum(null);
  }

  // ---------- Teileliste aus PDF-Bauanleitung extrahieren ----------
  function triggerPdfUpload(setNum) {
    pdfInputSetNumRef.current = setNum;
    pdfInputRef.current?.click();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Gemeinsame Analyse-Logik: bekommt fertige Bilder (Base64, egal ob aus PDF gerendert oder
  // direkt als Screenshot hochgeladen) und extrahiert daraus die Teileliste + Einzelbilder.
  async function processPartsListImages(setNum, pageImages) {
    persistPartsListPages({ ...partsListPages, [setNum]: pageImages });

    const pageImageBlocks = pageImages.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: img },
    }));

    const response = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        messages: [
          {
            role: "user",
            content: [
              ...pageImageBlocks,
              {
                type: "text",
                text:
                  `Ich sortiere gerade lose LEGO-Teile aus meinem eigenen Set zu Hause und möchte ` +
                  `dafür meinen eigenen Bestand digital erfassen. Die ${pageImages.length} Bilder ` +
                  "oben sind Fotos/Screenshots aus der Bauanleitung, die diesem Set beiliegt - dort " +
                  "steht die Teileliste: eine Tabelle mit vielen Einträgen, jeder Eintrag zeigt eine " +
                  "Stückzahl (z.B. '1x', '4x'), eine kleine Bild-Illustration des Teils UND eine " +
                  "Element-/Teilenummer (z.B. '303901', '6135105'). Diese Listen haben KEINEN " +
                  "Textnamen und KEINE Farbe als Wort aufgedruckt - bitte schätze Form und Farbe " +
                  "anhand der kleinen Illustration jedes Eintrags ein, das hilft mir beim Sortieren " +
                  "sehr. Bitte liste für mich alle Einträge auf, die du auf den Bildern erkennen " +
                  "kannst. Gib für jeden Eintrag an, in welchem Bild er zu sehen ist (0 = erstes " +
                  "Bild, 1 = zweites Bild, usw.) und die ungefähre Position/Größe seiner " +
                  "Illustration auf diesem Bild in Prozent (bezogen auf das ganze Bild, x/y von " +
                  "oben links). " +
                  "Antworte NUR mit einem JSON-Objekt ohne Markdown-Codeblock im Format: " +
                  '{"parts": [{"elementId": "die aufgedruckte Element-/Teilenummer als String, exakt wie im Bild", "name": "von DIR anhand der Illustration eingeschätzter Fachbegriff MIT Maßen im Format AxB, z.B. \'Stein 2x4\', \'Platte 1x2\', \'Fliese 2x2\', \'Dachstein 45° 2x2\'", "colorName": "von DIR anhand der Illustration eingeschätzt, EXAKT eine Farbe aus dieser Liste: ' +
                  LEGO_COLOR_PALETTE +
                  '", "qty": die aufgedruckte Stückzahl als Zahl (ohne das x), "pageIndex": 0-basierter Index des Bildes in dem dieser Eintrag zu sehen ist, "bbox": {"xPct": Zahl 0-100, "yPct": Zahl 0-100, "wPct": Zahl 0-100, "hPct": Zahl 0-100} der Illustration dieses Teils, oder null falls nicht bestimmbar}], "note": "falls du auf den Bildern KEINE Teileliste erkennen kannst, lass parts leer und beschreibe hier stattdessen kurz auf Deutsch, was du auf den Bildern tatsächlich siehst"}',
              },
            ],
          },
        ],
      }),
    });
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text.trim() : '{"parts": []}';
    const clean = raw.replace(/```json|```/g, "").trim();
    let parsed;
    let parseFailed = false;
    try {
      parsed = JSON.parse(clean);
    } catch (err) {
      parsed = { parts: [] };
      parseFailed = true;
    }
    const parts = Array.isArray(parsed.parts) ? parsed.parts : [];

    if (parts.length === 0) {
      const note = parsed?.note;
      showToast(
        parseFailed
          ? `Unvollständige Antwort: ${raw.slice(0, 200)}`
          : `KI sieht: ${note || raw.slice(0, 200)}`,
        "warn"
      );
      return;
    }

    persistPartsLists({ ...partsLists, [setNum]: parts });
    showToast(`${parts.length} Teile für ${setNum} hinterlegt`, "good");

    // Pro Teil ein einzelnes Bild ausschneiden (anhand der von der KI gelieferten Position) -
    // einmalig hier, nicht bei jedem einzelnen Scan.
    const crops = await Promise.all(
      parts.map(async (p) => {
        const pageImg = pageImages[p.pageIndex] ?? pageImages[0];
        if (!pageImg) return null;
        if (p.bbox) {
          try {
            return await cropImageRegion(pageImg, p.bbox);
          } catch (e) {
            return `data:image/jpeg;base64,${pageImg}`;
          }
        }
        return `data:image/jpeg;base64,${pageImg}`;
      })
    );
    persistPartImages({ ...partImages, [setNum]: crops });
  }

  async function handlePdfSelected(e) {
    const file = e.target.files?.[0];
    const setNum = pdfInputSetNumRef.current;
    e.target.value = "";
    if (!file || !setNum) return;

    const manualInputRaw = (pageNumberInputs[setNum] || "").trim();
    const manualPages = manualInputRaw
      ? manualInputRaw
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n) && n > 0)
      : [];

    if (manualPages.length === 0) {
      showToast("Bitte zuerst die Seitenzahl(en) der Teileliste oben eintragen", "warn");
      return;
    }
    if (!pdfjsReady || pdfjsFailed) {
      showToast("Seiten-Renderer nicht bereit — bitte kurz warten und nochmal versuchen", "warn");
      return;
    }

    setPdfUploadingFor(setNum);
    try {
      const pdfBase64 = await fileToBase64(file);

      // WICHTIG: Wir schicken nie die komplette PDF an den Server - Vercels Serverless
      // Functions blocken Anfragen über 4.5MB hart, und eine ganze Bauanleitung (mit vielen
      // Bau-Schritt-Bildern) ist fast immer größer. Stattdessen rendern wir NUR die vom Nutzer
      // angegebenen Teileliste-Seiten lokal im Browser zu Bildern (klein, meist <1MB) und
      // schicken nur die zur Analyse.
      const pageImages = await renderPdfPagesToImages(pdfBase64, manualPages);
      if (pageImages.length === 0) {
        showToast("Angegebene Seite(n) konnten nicht gerendert werden — Seitenzahl korrekt?", "warn");
        return;
      }
      await processPartsListImages(setNum, pageImages);
    } catch (err) {
      showToast(`Fehler: ${err?.message || err}`.slice(0, 120), "warn");
    } finally {
      setPdfUploadingFor(null);
    }
  }

  // ---------- Alternative: Teileliste als Screenshot/Foto hochladen ----------
  // Umgeht jede Unsicherheit über PDF-Seitenzahlen (gedruckte Seitenzahl vs. tatsächliche
  // PDF-Seite) - der Nutzer macht/wählt einfach ein Bild der Teileliste-Seite direkt.
  function triggerTeilelisteImageUpload(setNum) {
    pdfInputSetNumRef.current = setNum;
    teilelisteImageInputRef.current?.click();
  }

  async function handleTeilelisteImagesSelected(e) {
    const files = Array.from(e.target.files || []);
    const setNum = pdfInputSetNumRef.current;
    e.target.value = "";
    if (files.length === 0 || !setNum) return;

    setPdfUploadingFor(setNum);
    try {
      const images = await Promise.all(files.map((f) => fileToHighResBase64(f)));
      await processPartsListImages(setNum, images);
    } catch (err) {
      showToast(`Fehler: ${err?.message || err}`.slice(0, 120), "warn");
    } finally {
      setPdfUploadingFor(null);
    }
  }

  // ---------- Fotoauswahl ----------
  function takePhoto() {
    fileInputRef.current?.click();
  }

  // ---------- Live-Kamera-Scan ----------
  // Läuft dauerhaft mit, filmt wie ein QR-Scanner: alle paar Sekunden wird automatisch ein
  // Frame erfasst und in dieselbe Warteschlange gelegt wie ein hochgeladenes Foto - die
  // komplette Erkennungs-/Abgleichs-/Bestätigungslogik danach ist identisch.
  async function startLiveCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      // Das <video>-Element existiert erst NACHDEM liveMode true wird und React neu gerendert
      // hat - den Stream deshalb nicht hier direkt zuweisen (videoRef.current ist noch null),
      // sondern im useEffect unten, der auf liveMode reagiert.
      setLiveMode(true);
      setLiveScanning(true);
      liveScanningRef.current = true;
      liveIntervalRef.current = setInterval(captureLiveFrame, LIVE_SCAN_INTERVAL_MS);
    } catch (e) {
      setCameraError("Kamera konnte nicht gestartet werden. Bitte Kamerazugriff im Browser erlauben.");
    }
  }

  // Hängt den Kamera-Stream an das <video>-Element an, sobald es tatsächlich im DOM existiert.
  useEffect(() => {
    if (liveMode && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [liveMode]);

  function stopLiveCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (liveIntervalRef.current) {
      clearInterval(liveIntervalRef.current);
      liveIntervalRef.current = null;
    }
    liveScanningRef.current = false;
    setLiveScanning(false);
    setLiveMode(false);
  }

  function captureLiveFrame() {
    // Während ein Treffer zur Bestätigung ansteht, nicht weiter Frames aufnehmen -
    // erst wenn bestätigt/übersprungen wurde, geht's automatisch weiter.
    if (!liveScanningRef.current) return;
    const alreadyReviewing = photos.some((p) => p.status === "reviewing");
    if (alreadyReviewing) return;

    const video = videoRef.current;
    const canvas = liveCanvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return;
    const targetW = 1024;
    const scale = Math.min(1, targetW / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];

    setLiveAnalyzing(true);
    setTimeout(() => setLiveAnalyzing(false), 800); // kurzes visuelles Feedback im UI
    setPhotos((prev) => [...prev, makePhotoItem(`${Date.now()}-${Math.random()}`, base64)]);
  }

  useEffect(() => {
    return () => {
      // Aufräumen, falls die Komponente verlassen wird während die Kamera läuft
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
    };
  }, []);

  async function handleFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // erlaubt erneutes Auswählen derselben Datei später
    if (files.length === 0) return;

    const newItems = [];
    for (const file of files) {
      const base64 = await fileToResizedBase64(file);
      newItems.push(makePhotoItem(`${Date.now()}-${Math.random()}`, base64));
    }
    setPhotos((prev) => [...prev, ...newItems]);
    showToast("Foto hinzugefügt");
  }

  function fileToResizedBase64(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => {
        img.onload = () => {
          const targetW = 1200;
          const scale = Math.min(1, targetW / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Für Teileliste-Screenshots: viel höher aufgelöst als das 640px-Einzelteil-Foto, da hier
  // viele kleine Element-IDs/Zahlen lesbar bleiben müssen. Läuft nur einmalig pro Set, nicht
  // bei jedem Scan - Dateigröße ist hier zweitrangig gegenüber Lesbarkeit.
  function fileToHighResBase64(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => {
        img.onload = () => {
          const targetW = 2000;
          const scale = Math.min(1, targetW / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.92).split(",")[1]);
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---------- Warteschlange automatisch abarbeiten ----------
  useEffect(() => {
    if (processingRef.current) return;
    const alreadyReviewing = photos.some((p) => p.status === "reviewing");
    if (alreadyReviewing) return;
    const next = photos.find((p) => p.status === "pending");
    if (!next) return;

    processingRef.current = true;
    analyzePhoto(next.id).finally(() => {
      processingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos]);

  function updatePhoto(id, patch) {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  async function analyzePhoto(id) {
    updatePhoto(id, { status: "analyzing" });
    const photo = photos.find((p) => p.id === id);
    if (!photo) return;

    setLastDebugRequest(
      `Bild-Größe (base64): ${Math.round((photo.base64.length * 0.75) / 1024)} KB · gesendet um ${new Date().toLocaleTimeString("de-DE")}`
    );

    try {
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: photo.base64 },
                },
                {
                  type: "text",
                  text:
                    "Das ist ein Foto, das für die Sortierung von LEGO-Teilen aufgenommen wurde. " +
                    "Im Bild sollte ein einzelnes LEGO-Teil zu sehen sein, eventuell mit einem " +
                    "zusätzlichen kleinen Referenzstein (Stein 1x2, hochkant) rechts daneben zur " +
                    "Größeneinschätzung - falls vorhanden, nutze ihn als Maßstab. " +
                    "Beschreibe IMMER, was du im Bild siehst - auch wenn du dir nicht sicher bist. " +
                    "Antworte NUR mit einem JSON-Objekt ohne Markdown-Codeblock, in GENAU diesem " +
                    "Format (kein anderes, kürzeres Format verwenden): " +
                    '{"sceneDescription": "kurze Beschreibung auf Deutsch, was insgesamt im Bild zu sehen ist (Gegenstände, Hintergrund, Beleuchtung)", "shapeName": "Fachbegriff MIT Maßen im Format AxB des Hauptteils, z.B. \'Stein 2x4\', \'Platte 1x2\', \'Fliese 2x2\', \'Dachstein 45° 2x2\' - oder null falls kein LEGO-Teil erkennbar ist", "colorName": "EXAKT eine Farbe aus dieser Liste, die am besten passt: ' +
                    LEGO_COLOR_PALETTE +
                    '" - oder null", "elementIdGuess": "geschätzte LEGO Element-ID falls am Teil lesbar aufgedruckt, sonst null", "referenceBrickUsed": true oder false, "confidence": "high|medium|low|none - none nur wenn WIRKLICH kein LEGO-Teil im Bild ist"}',
                },
              ],
            },
          ],
        }),
      });
      const data = await response.json();
      const textBlock = (data.content || []).find((b) => b.type === "text");
      const raw = textBlock ? textBlock.text.trim() : `KEIN TEXT IN ANTWORT — volle Server-Antwort: ${JSON.stringify(data).slice(0, 400)}`;
      const clean = raw.replace(/```json|```/g, "").trim();
      let parsed;
      let parseFailed = false;
      try {
        parsed = JSON.parse(clean);
      } catch (e) {
        parsed = { confidence: "none" };
        parseFailed = true;
      }

      const notDetected = parseFailed || !parsed.shapeName || parsed.confidence === "none";
      if (notDetected) {
        updatePhoto(id, { status: "no-part" });
        setLastDebugResponse(raw);
        showToast(`Kein Teil erkannt — KI-Antwort: ${raw.slice(0, 250)}`, "warn");
        return;
      }

      updatePhoto(id, { status: "reviewing", result: parsed, matchStatus: "checking" });
      setLastDebugResponse(raw);
      await matchAgainstSetsAI(id, parsed, photo.base64);
    } catch (e) {
      updatePhoto(id, { status: "no-part" });
      showToast(`Fehler bei der Erkennung: ${e?.message || e}`.slice(0, 150), "warn");
    }
  }

  // ---------- Set-Abgleich per KI ----------
  // Statt stur Zeichenketten zu vergleichen, bekommt die KI das Foto UND die kompletten
  // Teilelisten aller Sets mit hinterlegter Liste und beurteilt selbst, welche Einträge
  // plausibel zum fotografierten Teil passen (inkl. Synonymen wie "Winkelplatte"/"Eckplatte").
  async function matchAgainstSetsAI(id, part, base64) {
    if (mySets.length === 0) {
      updatePhoto(id, { matchStatus: "no-sets", candidateSets: [] });
      return;
    }
    const setsWithLists = mySets.filter((s) => (partsLists[s] || []).length > 0);
    if (setsWithLists.length === 0) {
      updatePhoto(id, { matchStatus: "no-key", candidateSets: [] });
      return;
    }

    const listsText = setsWithLists
      .map((setNum) => {
        const items = (partsLists[setNum] || [])
          .map((p, i) => `${i}:{id:"${p.elementId || ""}",name:"${p.name || ""}",color:"${p.colorName || ""}",qty:${p.qty || ""}}`)
          .join(", ");
        return `Set ${setNum}: [${items}]`;
      })
      .join("\n");

    // Falls vorhanden: echte Teileliste-Seitenbilder als zusätzlichen visuellen Kontext beifügen,
    // damit die KI das Foto direkt gegen die Original-Illustrationen abgleichen kann - nicht nur
    // gegen die Text-Beschreibung.
    const pageImageBlocks = [];
    let pageImageNote = "";
    setsWithLists.forEach((setNum) => {
      const pages = partsListPages[setNum] || [];
      pages.forEach((pageBase64, localIdx) => {
        pageImageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: pageBase64 },
        });
        pageImageNote += `[Bild ist Seitenbild ${localIdx} von Set ${setNum}] `;
      });
    });

    try {
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 800,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: base64 },
                },
                ...pageImageBlocks,
                {
                  type: "text",
                  text:
                    "Das ERSTE Bild oben zeigt ein einzelnes LEGO-Teil (vorläufig eingeschätzt als: " +
                    `Form "${part.shapeName}", Farbe "${part.colorName}"). ` +
                    pageImageNote +
                    "Nutze diese Seitenbilder aktiv für einen VISUELLEN Vergleich der Illustrationen " +
                    "mit dem fotografierten Teil, zusätzlich zur Textliste unten. " +
                    "Unten stehen die Teilelisten mehrerer LEGO-Sets, jeweils mit Index, Element-ID, " +
                    "Name/Form, Farbe und Stückzahl. Beurteile anhand des Fotos, der Seitenbilder UND " +
                    "der Textbeschreibung, welche Einträge plausibel genau dieses Teil sein könnten - " +
                    "auch wenn die Formulierung leicht abweicht (z.B. 'Winkelplatte' = 'Eckplatte', " +
                    "unterschiedliche Wortstellung, Abkürzungen). Berücksichtige Form, Maße UND Farbe " +
                    "gemeinsam, nicht nur eines davon. " +
                    "WICHTIG zur Priorität: Die Sets unten stehen in der Reihenfolge, in der der Nutzer " +
                    "sie eingetragen hat - das ERSTE Set hat Priorität. Wenn im ersten Set ein plausibler " +
                    "Treffer existiert, gib NUR diesen einen Treffer zurück (nicht zusätzlich Treffer aus " +
                    "späteren Sets) - so wird ein Set nach dem anderen vervollständigt statt Teile über " +
                    "mehrere Sets zu verteilen. Prüfe spätere Sets NUR, wenn im ersten Set kein " +
                    "plausibler Treffer existiert. Gib NUR plausible Treffer zurück, keine Zwangszuordnung.\n\n" +
                    listsText +
                    "\n\nAntworte NUR mit einem JSON-Array ohne Markdown-Codeblock, ein Eintrag pro " +
                    "plausiblem Treffer (leeres Array [] falls keiner passt), Format: " +
                    '[{"setNum": "Set-Nummer", "index": Index-Zahl des Eintrags aus der Liste, "matchedName": "name-Feld des Treffers", "confidence": "high|medium|low"}]',
                },
              ],
            },
          ],
        }),
      });
      const data = await response.json();
      const textBlock = (data.content || []).find((b) => b.type === "text");
      const raw = textBlock ? textBlock.text.trim() : `KEIN TEXT IN ANTWORT — volle Server-Antwort: ${JSON.stringify(data).slice(0, 400)}`;
      const clean = raw.replace(/```json|```/g, "").trim();
      let matches;
      try {
        matches = JSON.parse(clean);
        if (!Array.isArray(matches)) matches = [];
      } catch (e) {
        matches = [];
      }
      setLastDebugResponse(`[Abgleich] ${raw}`);

      updatePhoto(id, {
        matchStatus: matches.length > 0 ? "found" : "none",
        candidateSets: matches,
      });
    } catch (e) {
      updatePhoto(id, { matchStatus: "none", candidateSets: [] });
      showToast(`Abgleich fehlgeschlagen: ${e?.message || e}`.slice(0, 150), "warn");
    }
  }

  function confirmAssignment(id, setNum, partIndex, matchedName) {
    const photo = photos.find((p) => p.id === id);
    const entry = {
      id: Date.now(),
      shapeName: matchedName || photo?.result?.shapeName || "Unbekanntes Teil",
      colorName: photo?.result?.colorName || "",
      setNum,
      time: new Date().toLocaleString("de-DE"),
    };
    persistLog([entry, ...log]);

    if (partIndex !== null && partIndex !== undefined) {
      const setCounts = { ...(collectedCounts[setNum] || {}) };
      setCounts[partIndex] = (setCounts[partIndex] || 0) + 1;
      persistCollectedCounts({ ...collectedCounts, [setNum]: setCounts });
    }

    showToast(`Zugeordnet zu ${setNum}`, "good");
    updatePhoto(id, { status: "done" });
    setManualPickSet(null);
    setManualFilter("");
    setManualOverride(false);
  }

  function skipAssignment(id) {
    updatePhoto(id, { status: "done" });
    setManualPickSet(null);
    setManualFilter("");
    setManualOverride(false);
  }

  const reviewingPhoto = photos.find((p) => p.status === "reviewing");
  const pendingCount = photos.filter((p) => p.status === "pending" || p.status === "analyzing").length;
  const doneCount = photos.filter((p) => p.status === "done" || p.status === "no-part").length;

  // ---------- Vergleichsbild: fest gespeichertes Teilbild anzeigen (einmalig beim PDF-Upload erzeugt) ----------
  const [expandedThumb, setExpandedThumb] = useState(null);

  function cropImageRegion(pageBase64, bbox) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const sx = (bbox.xPct / 100) * img.width;
        const sy = (bbox.yPct / 100) * img.height;
        const sw = (bbox.wPct / 100) * img.width;
        const sh = (bbox.hPct / 100) * img.height;
        const canvas = document.createElement("canvas");
        // etwas Rand um den Ausschnitt herum, damit man das Teil im Kontext sieht
        const pad = 0.4;
        const px = Math.max(0, sx - sw * pad);
        const py = Math.max(0, sy - sh * pad);
        const pw = Math.min(img.width - px, sw * (1 + 2 * pad));
        const ph = Math.min(img.height - py, sh * (1 + 2 * pad));
        canvas.width = 160;
        canvas.height = 160 * (ph / pw || 1);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, px, py, pw, ph, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = reject;
      img.src = `data:image/jpeg;base64,${pageBase64}`;
    });
  }

  // Liefert das Vergleichsbild für einen Treffer: zuerst das fest gespeicherte Teilbild,
  // sonst als Fallback die ganze Teileliste-Seite (falls vorhanden), sonst nichts.
  function getMatchThumb(m) {
    const entry = (partsLists[m.setNum] || [])[m.index];
    if (entry?.imageUrl) return entry.imageUrl;
    const stored = (partImages[m.setNum] || [])[m.index];
    if (stored) return stored;
    const pages = partsListPages[m.setNum] || [];
    if (pages.length > 0) return `data:image/jpeg;base64,${pages[0]}`;
    return null;
  }

  // ---------- UI ----------
  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.bg,
        color: COLORS.text,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes slideUp { from{transform:translateY(12px);opacity:0} to{transform:translateY(0);opacity:1} }
        @keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        * { box-sizing: border-box; }
        button { font-family: inherit; cursor: pointer; }
        input { font-family: inherit; }
      `}</style>

      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 20px",
          borderBottom: `1px solid ${COLORS.panelBorder}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", gap: 3 }}>
            <Stud size={9} color={COLORS.accent} />
            <Stud size={9} color="#f0c419" />
            <Stud size={9} color="#2d7fe0" />
          </div>
          <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em" }}>
            Brick Sorter
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={() => setScreen(screen === "overview" ? "setup" : "overview")}
            style={{ background: "transparent", border: "none", color: COLORS.textDim, padding: 6, display: "flex" }}
            aria-label="Fehlteile-Übersicht"
          >
            <ClipboardList size={20} />
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            style={{ background: "transparent", border: "none", color: COLORS.textDim, padding: 6, display: "flex" }}
            aria-label="Einstellungen"
          >
            <Settings size={20} />
          </button>
        </div>
      </header>

      {showSettings && (
        <div
          style={{
            padding: 16,
            background: COLORS.panel,
            borderBottom: `1px solid ${COLORS.panelBorder}`,
            animation: "slideUp 0.15s ease",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Rebrickable-API-Key</div>
          <p style={{ fontSize: 12, color: COLORS.textDim, lineHeight: 1.5, marginBottom: 8 }}>
            Empfohlener Weg, um Teilelisten zu laden: echte Herstellerdaten inkl. offizieller
            Teilbilder, direkt über die Setnummer. Kostenlos erstellbar unter{" "}
            <span style={{ color: COLORS.text }}>rebrickable.com → Settings → API</span>.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={rebrickableKeyDraft}
              onChange={(e) => setRebrickableKeyDraft(e.target.value)}
              placeholder="dein Rebrickable API-Key"
              style={{
                flex: 1,
                background: COLORS.bg,
                border: `1px solid ${COLORS.panelBorder}`,
                borderRadius: 8,
                padding: "10px 12px",
                color: COLORS.text,
                fontSize: 14,
              }}
            />
            <button
              onClick={() => {
                persistRebrickableKey(rebrickableKeyDraft);
                showToast("Rebrickable-Key gespeichert", "good");
              }}
              style={{
                background: COLORS.accent,
                border: "none",
                borderRadius: 8,
                padding: "10px 16px",
                color: "#fff",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              Speichern
            </button>
          </div>
          <p style={{ fontSize: 12, color: COLORS.textDim, marginTop: 12, lineHeight: 1.5 }}>
            Alternativ (ohne Key): Teileliste als PDF-Seitenzahl oder Screenshot/Foto hochladen —
            läuft über KI-Bilderkennung und ist etwas weniger zuverlässig.
          </p>

          <div style={{ borderTop: `1px solid ${COLORS.panelBorder}`, marginTop: 16, paddingTop: 12 }}>
            <button
              onClick={() => setShowDebug((v) => !v)}
              style={{ background: "transparent", border: "none", color: COLORS.textDim, fontSize: 12, padding: 0, display: "flex", alignItems: "center", gap: 4 }}
            >
              {showDebug ? "▾" : "▸"} Debug: letzte KI-Anfrage/-Antwort anzeigen
            </button>
            {showDebug && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 3 }}>Anfrage (Foto-Erkennung):</div>
                  <div
                    style={{
                      background: COLORS.bg,
                      border: `1px solid ${COLORS.panelBorder}`,
                      borderRadius: 6,
                      padding: 8,
                      fontSize: 11,
                      color: COLORS.text,
                      fontFamily: "monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {lastDebugRequest || "(noch keine Anfrage gesendet)"}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 3 }}>Rohe KI-Antwort:</div>
                  <div
                    style={{
                      background: COLORS.bg,
                      border: `1px solid ${COLORS.panelBorder}`,
                      borderRadius: 6,
                      padding: 8,
                      fontSize: 11,
                      color: COLORS.text,
                      fontFamily: "monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 200,
                      overflowY: "auto",
                    }}
                  >
                    {lastDebugResponse || "(noch keine Antwort erhalten)"}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {screen === "setup" && (
        <main style={{ flex: 1, padding: 20, maxWidth: 480, margin: "0 auto", width: "100%" }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, letterSpacing: "-0.02em" }}>
            Deine Sets
          </h1>
          <p style={{ color: COLORS.textDim, fontSize: 14, marginBottom: 20, lineHeight: 1.5 }}>
            Trag die Setnummern ein, zu denen lose Teile gehören könnten. Beim Scannen gleichen wir
            jedes erkannte Teil gegen diese Liste ab.
          </p>

          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input
              value={newSetInput}
              onChange={(e) => setNewSetInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSet()}
              placeholder="z.B. 75192 oder 75192-1"
              style={{
                flex: 1,
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelBorder}`,
                borderRadius: 10,
                padding: "12px 14px",
                color: COLORS.text,
                fontSize: 15,
              }}
            />
            <button
              onClick={addSet}
              style={{
                background: COLORS.accent,
                border: "none",
                borderRadius: 10,
                width: 46,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              aria-label="Set hinzufügen"
            >
              <Plus size={20} color="#fff" />
            </button>
          </div>

          {mySets.length === 0 ? (
            <div
              style={{
                border: `1px dashed ${COLORS.panelBorder}`,
                borderRadius: 12,
                padding: "28px 16px",
                textAlign: "center",
                color: COLORS.textDim,
                fontSize: 14,
              }}
            >
              <Package size={26} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>Noch keine Sets eingetragen.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
              {mySets.map((s) => {
                const partsCount = (partsLists[s] || []).length;
                const uploading = pdfUploadingFor === s;
                const meta = setMeta[s];
                const isExpanded = expandedSetNum === s;
                return (
                  <div
                    key={s}
                    style={{
                      background: COLORS.panel,
                      border: `1px solid ${COLORS.panelBorder}`,
                      borderRadius: 10,
                      overflow: "hidden",
                    }}
                  >
                    <button
                      onClick={() => setExpandedSetNum(isExpanded ? null : s)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 14px",
                        background: "transparent",
                        border: "none",
                        textAlign: "left",
                      }}
                    >
                      {meta?.imgUrl ? (
                        <img
                          src={meta.imgUrl}
                          alt=""
                          style={{ width: 36, height: 36, objectFit: "contain", borderRadius: 6, background: "#fff", flexShrink: 0 }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 6,
                            background: COLORS.bg,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <Package size={16} color={COLORS.textDim} />
                        </div>
                      )}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, display: "block" }}>{s}</span>
                        <span
                          style={{
                            fontSize: 11,
                            color: partsCount > 0 ? COLORS.good : COLORS.textDim,
                            display: "block",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {partsCount > 0 ? `${partsCount} Teile hinterlegt` : "Keine Teileliste"}
                        </span>
                      </span>
                      <X
                        size={16}
                        color={COLORS.textDim}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeSet(s);
                        }}
                        style={{ flexShrink: 0 }}
                      />
                      <ChevronRight
                        size={16}
                        color={COLORS.textDim}
                        style={{ flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                      />
                    </button>

                    {isExpanded && (
                      <div style={{ padding: "0 14px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                          {(partsListPages[s] || []).length > 0 && (
                            <span style={{ fontSize: 11, color: COLORS.good }}>inkl. Bildabgleich</span>
                          )}
                          <button
                            onClick={() => loadPartsListFromRebrickable(s)}
                            disabled={rebrickableLoadingFor === s}
                            style={{
                              marginLeft: "auto",
                              background: COLORS.accent,
                              border: "none",
                              borderRadius: 8,
                              padding: "5px 10px",
                              color: "#fff",
                              fontSize: 12,
                              fontWeight: 600,
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            {rebrickableLoadingFor === s ? (
                              <>
                                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> Lädt...
                              </>
                            ) : (
                              <>
                                <Download size={12} /> {partsCount > 0 ? "Neu laden" : "Von Rebrickable laden"}
                              </>
                            )}
                          </button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0" }}>
                          <div style={{ flex: 1, height: 1, background: COLORS.panelBorder }} />
                          <span style={{ fontSize: 10, color: COLORS.textDim }}>oder ohne Rebrickable-Key</span>
                          <div style={{ flex: 1, height: 1, background: COLORS.panelBorder }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button
                            onClick={() => triggerPdfUpload(s)}
                            disabled={uploading}
                            style={{
                              background: "transparent",
                              border: `1px solid ${COLORS.panelBorder}`,
                              borderRadius: 8,
                              padding: "5px 10px",
                              color: COLORS.text,
                              fontSize: 12,
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            {uploading ? (
                              <>
                                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> Liest ein...
                              </>
                            ) : (
                              <>
                                <FileUp size={12} /> Anleitung (PDF)
                              </>
                            )}
                          </button>
                        </div>
                        <input
                          value={pageNumberInputs[s] || ""}
                          onChange={(e) => setPageNumberInputs({ ...pageNumberInputs, [s]: e.target.value })}
                          placeholder="Seiten der Teileliste, z.B. 12,13 (erforderlich)"
                          style={{
                            width: "100%",
                            background: COLORS.bg,
                            border: `1px solid ${COLORS.panelBorder}`,
                            borderRadius: 7,
                            padding: "7px 10px",
                            color: COLORS.text,
                            fontSize: 12,
                            marginTop: 8,
                          }}
                        />
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                          <div style={{ flex: 1, height: 1, background: COLORS.panelBorder }} />
                          <span style={{ fontSize: 10, color: COLORS.textDim }}>oder</span>
                          <div style={{ flex: 1, height: 1, background: COLORS.panelBorder }} />
                        </div>
                        <button
                          onClick={() => triggerTeilelisteImageUpload(s)}
                          disabled={uploading}
                          style={{
                            width: "100%",
                            marginTop: 8,
                            background: "transparent",
                            border: `1px dashed ${COLORS.panelBorder}`,
                            borderRadius: 8,
                            padding: "8px 10px",
                            color: COLORS.textDim,
                            fontSize: 12,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 5,
                          }}
                        >
                          <Camera size={12} /> Teileliste als Screenshot/Foto hochladen (statt PDF-Seitenzahl)
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <input
            ref={pdfInputRef}
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={handlePdfSelected}
          />
          <input
            ref={teilelisteImageInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleTeilelisteImagesSelected}
          />

          <button
            onClick={() => setScreen("scan")}
            disabled={mySets.length === 0}
            style={{
              width: "100%",
              background: mySets.length === 0 ? COLORS.panel : COLORS.accent,
              opacity: mySets.length === 0 ? 0.5 : 1,
              border: "none",
              borderRadius: 12,
              padding: "16px",
              color: "#fff",
              fontWeight: 700,
              fontSize: 15,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <Camera size={18} /> Fotos aufnehmen <ChevronRight size={16} />
          </button>

          {log.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <h2 style={{ fontSize: 14, color: COLORS.textDim, fontWeight: 700, marginBottom: 10 }}>
                ZULETZT ZUGEORDNET
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {log.slice(0, 6).map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      fontSize: 13,
                      color: COLORS.textDim,
                      display: "flex",
                      justifyContent: "space-between",
                      borderBottom: `1px solid ${COLORS.panelBorder}`,
                      padding: "6px 0",
                    }}
                  >
                    <span>
                      {entry.shapeName} {entry.colorName ? `· ${entry.colorName}` : ""}
                    </span>
                    <span style={{ color: COLORS.accent, fontWeight: 600 }}>{entry.setNum}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      )}

      {screen === "overview" && (
        <main style={{ flex: 1, padding: 20, maxWidth: 480, margin: "0 auto", width: "100%" }}>
          <input
            ref={backupInputRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={handleBackupSelected}
          />
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, letterSpacing: "-0.02em" }}>
            Teile-Übersicht
          </h1>
          <p style={{ color: COLORS.textDim, fontSize: 14, marginBottom: 14, lineHeight: 1.5 }}>
            Sollmenge aus der Anleitung vs. bereits zugeordnete Teile. Nur Sets mit hochgeladener
            Teileliste werden hier ausgewertet.
          </p>

          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <button
              onClick={exportMissingListCsv}
              style={{
                flex: 1,
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelBorder}`,
                borderRadius: 10,
                padding: "10px 8px",
                color: COLORS.text,
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <Download size={14} /> Fehlteile (CSV)
            </button>
            <button
              onClick={exportBackup}
              style={{
                flex: 1,
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelBorder}`,
                borderRadius: 10,
                padding: "10px 8px",
                color: COLORS.text,
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <Download size={14} /> Sicherung
            </button>
            <button
              onClick={triggerBackupUpload}
              style={{
                flex: 1,
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelBorder}`,
                borderRadius: 10,
                padding: "10px 8px",
                color: COLORS.text,
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <Upload size={14} /> Laden
            </button>
          </div>

          {mySets.filter((s) => (partsLists[s] || []).length > 0).length === 0 ? (
            <div
              style={{
                border: `1px dashed ${COLORS.panelBorder}`,
                borderRadius: 12,
                padding: "28px 16px",
                textAlign: "center",
                color: COLORS.textDim,
                fontSize: 14,
              }}
            >
              <ClipboardList size={26} style={{ marginBottom: 8, opacity: 0.6 }} />
              <div>Noch keine Teileliste hochgeladen.</div>
            </div>
          ) : (
            mySets
              .filter((s) => (partsLists[s] || []).length > 0)
              .map((setNum) => {
                const list = partsLists[setNum] || [];
                const counts = collectedCounts[setNum] || {};
                const rows = list.map((p, idx) => ({
                  ...p,
                  idx,
                  collected: counts[idx] || 0,
                  missing: Math.max(0, (p.qty || 0) - (counts[idx] || 0)),
                }));
                const totalNeeded = rows.reduce((sum, r) => sum + (r.qty || 0), 0);
                const totalCollected = rows.reduce((sum, r) => sum + Math.min(r.collected, r.qty || 0), 0);
                const complete = totalCollected >= totalNeeded;
                const meta = setMeta[setNum];
                const isExpanded = expandedOverviewSet === setNum;

                return (
                  <div
                    key={setNum}
                    style={{
                      background: COLORS.panel,
                      border: `1px solid ${complete ? COLORS.good : COLORS.panelBorder}`,
                      borderRadius: 12,
                      overflow: "hidden",
                      marginBottom: 12,
                    }}
                  >
                    <button
                      onClick={() => setExpandedOverviewSet(isExpanded ? null : setNum)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: 14,
                        background: "transparent",
                        border: "none",
                        textAlign: "left",
                      }}
                    >
                      {meta?.imgUrl ? (
                        <img
                          src={meta.imgUrl}
                          alt=""
                          style={{ width: 32, height: 32, objectFit: "contain", borderRadius: 6, background: "#fff", flexShrink: 0 }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 6,
                            background: COLORS.bg,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <Package size={14} color={COLORS.textDim} />
                        </div>
                      )}
                      <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{setNum}</span>
                      <span style={{ fontSize: 12, color: complete ? COLORS.good : COLORS.textDim, display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        {complete && <Check size={13} />}
                        {totalCollected}/{totalNeeded} Teile
                      </span>
                      <ChevronRight
                        size={16}
                        color={COLORS.textDim}
                        style={{ flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                      />
                    </button>

                    {isExpanded && (
                      <div style={{ padding: "0 14px 14px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {rows
                        .sort((a, b) => a.missing - b.missing) // fehlende zuerst
                        .map((r) => {
                          const found = r.missing === 0;
                          const partial = !found && r.collected > 0;
                          const thumb = r.imageUrl || (partImages[setNum] || [])[r.idx];
                          return (
                            <div
                              key={r.idx}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                fontSize: 13,
                                color: found ? COLORS.good : COLORS.textDim,
                                padding: "4px 0",
                                borderTop: `1px solid ${COLORS.panelBorder}`,
                                gap: 8,
                              }}
                            >
                              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                {thumb && (
                                  <img
                                    src={thumb}
                                    alt=""
                                    style={{ width: 26, height: 26, objectFit: "contain", borderRadius: 4, background: "#fff", flexShrink: 0 }}
                                  />
                                )}
                                {found && <Check size={12} style={{ flexShrink: 0 }} />}
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {r.name} · {r.colorName}
                                </span>
                              </span>
                              <span style={{ fontWeight: 600, flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
                                {found ? (
                                  <span style={{ color: COLORS.good }}>{r.collected}/{r.qty}</span>
                                ) : (
                                  <>
                                    <span style={{ color: partial ? COLORS.good : COLORS.textDim }}>{r.collected}</span>
                                    <span style={{ color: COLORS.textDim, fontWeight: 400 }}> von </span>
                                    <span style={{ color: COLORS.textDim, fontWeight: 400 }}>{r.qty} gefunden</span>
                                    <span style={{ color: COLORS.warn }}> · {r.missing} fehlen</span>
                                  </>
                                )}
                                {!found && r.elementId ? ` (ID ${r.elementId})` : ""}
                                {r.collected > 0 && (
                                  <button
                                    onClick={() => decrementCollected(setNum, r.idx)}
                                    aria-label="Zuordnung zurücknehmen"
                                    style={{
                                      background: COLORS.bg,
                                      border: `1px solid ${COLORS.panelBorder}`,
                                      borderRadius: 6,
                                      width: 22,
                                      height: 22,
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      color: COLORS.textDim,
                                      flexShrink: 0,
                                    }}
                                  >
                                    <Minus size={12} />
                                  </button>
                                )}
                              </span>
                            </div>
                          );
                        })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
          )}
        </main>
      )}

      {screen === "scan" && (
        <main style={{ flex: 1, display: "flex", flexDirection: "column", maxWidth: 480, margin: "0 auto", width: "100%" }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            style={{ display: "none" }}
            onChange={handleFilesSelected}
          />

          <div style={{ padding: 20 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 16, background: COLORS.panel, borderRadius: 10, padding: 4 }}>
              <button
                onClick={() => {
                  if (liveMode) stopLiveCamera();
                }}
                style={{
                  flex: 1,
                  background: !liveMode ? COLORS.accent : "transparent",
                  border: "none",
                  borderRadius: 7,
                  padding: "8px 0",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Einzelfoto
              </button>
              <button
                onClick={() => {
                  if (!liveMode) startLiveCamera();
                }}
                style={{
                  flex: 1,
                  background: liveMode ? COLORS.accent : "transparent",
                  border: "none",
                  borderRadius: 7,
                  padding: "8px 0",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Live-Scan
              </button>
            </div>

            {liveMode && (
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    aspectRatio: "3/4",
                    maxHeight: "50vh",
                    background: "#000",
                    borderRadius: 12,
                    overflow: "hidden",
                  }}
                >
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    onLoadedMetadata={() => videoRef.current?.play().catch(() => {})}
                    onClick={() => videoRef.current?.play().catch(() => {})}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                  <canvas ref={liveCanvasRef} style={{ display: "none" }} />
                  <div
                    style={{
                      position: "absolute",
                      inset: "18% 12%",
                      border: `2px solid ${liveAnalyzing ? COLORS.warn : COLORS.accent}`,
                      borderRadius: 16,
                      pointerEvents: "none",
                    }}
                  />
                  {cameraError && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 20,
                        textAlign: "center",
                        background: "rgba(0,0,0,0.75)",
                        fontSize: 13,
                        color: "#fff",
                      }}
                    >
                      {cameraError}
                    </div>
                  )}
                  <div
                    style={{
                      position: "absolute",
                      top: 10,
                      left: 10,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "rgba(0,0,0,0.55)",
                      borderRadius: 20,
                      padding: "5px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#fff",
                    }}
                  >
                    {photos.some((p) => p.status === "reviewing") ? "Pausiert — Treffer bestätigen" : "Scan läuft"}
                  </div>
                  <div
                    style={{
                      position: "absolute",
                      bottom: 10,
                      left: 10,
                      right: 10,
                      textAlign: "center",
                      background: "rgba(0,0,0,0.55)",
                      borderRadius: 10,
                      padding: "5px 8px",
                      fontSize: 10,
                      color: "rgba(255,255,255,0.7)",
                    }}
                  >
                    Bleibt das Bild schwarz? Einmal auf das Bild tippen.
                  </div>
                </div>
                <button
                  onClick={stopLiveCamera}
                  style={{
                    width: "100%",
                    marginTop: 10,
                    background: "transparent",
                    border: `1px solid ${COLORS.panelBorder}`,
                    borderRadius: 10,
                    padding: 10,
                    color: COLORS.textDim,
                    fontSize: 13,
                  }}
                >
                  Live-Scan beenden
                </button>
              </div>
            )}

            {!liveMode && (
              <>
                <p style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
                  Tippe für jedes Teil einmal auf "Foto aufnehmen" — deine Kamera-App öffnet sich, du
                  fotografierst, danach automatisch zurück zum Tool. Nacheinander fotografierte Teile
                  werden automatisch der Reihe nach erkannt.
                </p>
                <p
                  style={{
                    color: COLORS.warn,
                    fontSize: 12,
                    marginBottom: 14,
                    lineHeight: 1.5,
                    display: "flex",
                    gap: 6,
                    background: "rgba(224,167,45,0.08)",
                    border: `1px solid ${COLORS.warn}`,
                    borderRadius: 8,
                    padding: "8px 10px",
                  }}
                >
                  💡 Tipp: Leg einen bekannten Stein 1x2 (hoch, "dick") als Größenvergleich immer
                  rechts neben das Teil — das hilft bei der Maßeinschätzung deutlich.
                </p>
                <button
                  onClick={takePhoto}
                  style={{
                    width: "100%",
                    background: COLORS.accent,
                    border: "none",
                    borderRadius: 12,
                    padding: 14,
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 15,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  <Camera size={18} /> Foto aufnehmen
                </button>
              </>
            )}

            {photos.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, fontSize: 12, color: COLORS.textDim }}>
                <span>{doneCount} erledigt</span>
                <span>·</span>
                <span>{pendingCount} in Warteschlange</span>
              </div>
            )}

            {photos.length > 0 && (
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {photos.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      position: "relative",
                      width: 44,
                      height: 44,
                      borderRadius: 8,
                      overflow: "hidden",
                      border: `2px solid ${
                        p.status === "reviewing"
                          ? COLORS.accent
                          : p.status === "done"
                          ? COLORS.good
                          : p.status === "no-part"
                          ? COLORS.warn
                          : COLORS.panelBorder
                      }`,
                      opacity: p.status === "done" || p.status === "no-part" ? 0.5 : 1,
                    }}
                  >
                    <img src={p.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    {p.status === "analyzing" && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          background: "rgba(0,0,0,0.5)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Loader2 size={16} color="#fff" style={{ animation: "spin 1s linear infinite" }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {reviewingPhoto && (
            <div style={{ padding: "0 20px 20px", animation: "slideUp 0.2s ease" }}>
              <div
                style={{
                  background: COLORS.panel,
                  border: `1px solid ${COLORS.panelBorder}`,
                  borderRadius: 14,
                  overflow: "hidden",
                  marginBottom: 16,
                }}
              >
                <img
                  src={reviewingPhoto.previewUrl}
                  alt=""
                  style={{ width: "100%", height: 160, objectFit: "cover" }}
                />
                <div style={{ padding: 16 }}>
                  <div style={{ fontSize: 11, color: COLORS.textDim, fontWeight: 700, marginBottom: 4 }}>
                    ERKANNT
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>{reviewingPhoto.result.shapeName}</div>
                  <div style={{ fontSize: 14, color: COLORS.textDim, marginTop: 2 }}>
                    {reviewingPhoto.result.colorName}
                    {reviewingPhoto.result.elementIdGuess
                      ? ` · vermutl. ID ${reviewingPhoto.result.elementIdGuess}`
                      : ""}
                  </div>
                  <div style={{ fontSize: 11, marginTop: 6, color: reviewingPhoto.result.referenceBrickUsed ? COLORS.good : COLORS.textDim }}>
                    {reviewingPhoto.result.referenceBrickUsed
                      ? "✓ Referenzstein erkannt und zur Kalibrierung genutzt"
                      : "Kein Referenzstein im Bild erkannt"}
                  </div>
                </div>
              </div>

              {reviewingPhoto.matchStatus === "checking" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.textDim, fontSize: 14, marginBottom: 12 }}>
                  <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Gleiche mit deinen Sets ab...
                </div>
              )}

              {reviewingPhoto.matchStatus === "found" && !manualOverride && (
                <>
                  <div style={{ fontSize: 13, color: COLORS.textDim, marginBottom: 8 }}>
                    Gehört möglicherweise zu:
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
                    {reviewingPhoto.candidateSets.map((m, i) => {
                      const thumb = getMatchThumb(m);
                      return (
                        <button
                          key={`${m.setNum}-${i}`}
                          onClick={() => confirmAssignment(reviewingPhoto.id, m.setNum, m.index, m.matchedName)}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            background: COLORS.panel,
                            border: `1px solid ${COLORS.good}`,
                            borderRadius: 10,
                            padding: "12px 14px",
                            color: COLORS.text,
                            fontSize: 15,
                            fontWeight: 600,
                            textAlign: "left",
                            gap: 10,
                          }}
                        >
                          {thumb && (
                            <img
                              src={thumb}
                              alt=""
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedThumb(thumb);
                              }}
                              style={{
                                width: 44,
                                height: 44,
                                objectFit: "contain",
                                borderRadius: 6,
                                background: "#fff",
                                flexShrink: 0,
                              }}
                            />
                          )}
                          <span style={{ flex: 1 }}>
                            {m.setNum}
                            {m.matchedName && (
                              <span style={{ display: "block", fontSize: 12, fontWeight: 400, color: COLORS.textDim }}>
                                {m.matchedName}
                                {m.confidence ? ` · ${m.confidence === "high" ? "sicher" : m.confidence === "medium" ? "wahrscheinlich" : "unsicher"}` : ""}
                              </span>
                            )}
                          </span>
                          <Check size={16} color={COLORS.good} style={{ flexShrink: 0 }} />
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => setManualOverride(true)}
                    style={{
                      width: "100%",
                      background: "transparent",
                      border: `1px dashed ${COLORS.panelBorder}`,
                      borderRadius: 8,
                      padding: 10,
                      color: COLORS.textDim,
                      fontSize: 12,
                      marginBottom: 8,
                    }}
                  >
                    Keins davon passt genau — aus vollständiger Liste wählen
                  </button>
                </>
              )}

              {(["none", "no-key", "no-sets"].includes(reviewingPhoto.matchStatus) ||
                (reviewingPhoto.matchStatus === "found" && manualOverride)) && (
                <>
                  <div style={{ fontSize: 13, color: COLORS.textDim, marginBottom: 8 }}>
                    {reviewingPhoto.matchStatus === "no-key" && "Für keins deiner Sets liegt eine Teileliste vor — wähle manuell:"}
                    {reviewingPhoto.matchStatus === "none" && "Kein automatischer Treffer in den hinterlegten Teilelisten — wähle manuell, falls es zu einem Set gehört:"}
                    {reviewingPhoto.matchStatus === "no-sets" && "Keine Sets hinterlegt."}
                    {reviewingPhoto.matchStatus === "found" && manualOverride && "Wähle das passende Teil aus der vollständigen Liste:"}
                  </div>

                  {reviewingPhoto.matchStatus === "found" && manualOverride && (
                    <button
                      onClick={() => setManualOverride(false)}
                      style={{ background: "transparent", border: "none", color: COLORS.textDim, fontSize: 12, padding: "0 0 8px", display: "block" }}
                    >
                      ← zurück zu den Vorschlägen
                    </button>
                  )}

                  {!manualPickSet ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
                      {mySets.map((s) => (
                        <button
                          key={s}
                          onClick={() => setManualPickSet(s)}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            background: COLORS.panel,
                            border: `1px solid ${COLORS.panelBorder}`,
                            borderRadius: 10,
                            padding: "12px 14px",
                            color: COLORS.text,
                            fontSize: 15,
                          }}
                        >
                          {s} <ChevronRight size={15} color={COLORS.textDim} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <button
                          onClick={() => {
                            setManualPickSet(null);
                            setManualFilter("");
                          }}
                          style={{ background: "transparent", border: "none", color: COLORS.textDim, fontSize: 13, padding: 4 }}
                        >
                          ← {manualPickSet}
                        </button>
                      </div>
                      {(partsLists[manualPickSet] || []).length > 8 && (
                        <input
                          value={manualFilter}
                          onChange={(e) => setManualFilter(e.target.value)}
                          placeholder="Teil suchen..."
                          style={{
                            width: "100%",
                            background: COLORS.bg,
                            border: `1px solid ${COLORS.panelBorder}`,
                            borderRadius: 8,
                            padding: "9px 12px",
                            color: COLORS.text,
                            fontSize: 14,
                            marginBottom: 8,
                          }}
                        />
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                        {(partsLists[manualPickSet] || [])
                          .map((p, idx) => ({ ...p, idx }))
                          .filter((p) => {
                            if (!manualFilter.trim()) return true;
                            const q = manualFilter.trim().toLowerCase();
                            return (p.name || "").toLowerCase().includes(q) || (p.colorName || "").toLowerCase().includes(q);
                          })
                          .map((p) => {
                            const collected = (collectedCounts[manualPickSet] || {})[p.idx] || 0;
                            const needed = p.qty || 0;
                            const thumb = p.imageUrl || (partImages[manualPickSet] || [])[p.idx];
                            return (
                              <button
                                key={p.idx}
                                onClick={() => confirmAssignment(reviewingPhoto.id, manualPickSet, p.idx, p.name)}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  background: COLORS.panel,
                                  border: `1px solid ${COLORS.panelBorder}`,
                                  borderRadius: 8,
                                  padding: "9px 12px",
                                  color: COLORS.text,
                                  fontSize: 13,
                                  textAlign: "left",
                                  gap: 8,
                                }}
                              >
                                {thumb && (
                                  <img
                                    src={thumb}
                                    alt=""
                                    style={{ width: 28, height: 28, objectFit: "contain", borderRadius: 4, background: "#fff", flexShrink: 0 }}
                                  />
                                )}
                                <span style={{ flex: 1 }}>
                                  {p.name} · {p.colorName}
                                </span>
                                <span style={{ color: collected >= needed ? COLORS.good : COLORS.textDim, fontSize: 12 }}>
                                  {collected}/{needed}
                                </span>
                              </button>
                            );
                          })}
                      </div>
                      <button
                        onClick={() => confirmAssignment(reviewingPhoto.id, manualPickSet, null, null)}
                        style={{
                          width: "100%",
                          background: "transparent",
                          border: `1px dashed ${COLORS.panelBorder}`,
                          borderRadius: 8,
                          padding: 10,
                          color: COLORS.textDim,
                          fontSize: 12,
                          marginTop: 8,
                        }}
                      >
                        Teil nicht in der Liste — trotzdem {manualPickSet} zuordnen
                      </button>
                    </div>
                  )}
                </>
              )}

              <button
                onClick={() => skipAssignment(reviewingPhoto.id)}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: `1px solid ${COLORS.panelBorder}`,
                  borderRadius: 10,
                  padding: 12,
                  color: COLORS.textDim,
                  fontSize: 14,
                  marginTop: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <SkipForward size={14} /> Überspringen, nächstes Foto
              </button>
            </div>
          )}

          <div style={{ padding: "0 20px 20px", marginTop: "auto" }}>
            <button
              onClick={() => setScreen("setup")}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                color: COLORS.textDim,
                fontSize: 13,
                padding: 10,
              }}
            >
              ← Zurück zur Set-Liste
            </button>
          </div>
        </main>
      )}

      {expandedThumb && (
        <div
          onClick={() => setExpandedThumb(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: 24,
          }}
        >
          <img src={expandedThumb} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />
        </div>
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            left: "50%",
            transform: "translateX(-50%)",
            background: toast.type === "good" ? COLORS.good : toast.type === "warn" ? COLORS.warn : COLORS.panel,
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 20,
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
            animation: "slideUp 0.2s ease",
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
