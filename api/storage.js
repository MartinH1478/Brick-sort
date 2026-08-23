// Vercel Serverless Function: gemeinsamer Online-Speicher für alle Nutzer der App
// (z.B. Vater + Sohn scannen gleichzeitig auf verschiedenen Handys, sehen denselben Stand).
// Nutzt Upstash Redis, das über die Vercel-Marketplace-Integration verbunden wird - die
// Umgebungsvariablen KV_REST_API_URL / KV_REST_API_TOKEN werden dabei automatisch gesetzt,
// kein manuelles Abtippen nötig.

export const config = {
  maxDuration: 30,
};

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = "brick-sorter:";

async function upstash(command) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  return res.json();
}

export default async function handler(req, res) {
  if (!BASE || !TOKEN) {
    res.status(500).json({
      error: "Gemeinsamer Speicher nicht eingerichtet (Upstash-Integration fehlt bei Vercel)",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const key = req.query.key;
      if (!key || typeof key !== "string") {
        res.status(400).json({ error: "kein key übergeben" });
        return;
      }
      const data = await upstash(["GET", PREFIX + key]);
      if (data.error) throw new Error(data.error);
      res.status(200).json({ value: data.result ?? null });
    } else if (req.method === "POST") {
      const { key, value } = req.body || {};
      if (!key || typeof key !== "string") {
        res.status(400).json({ error: "kein key übergeben" });
        return;
      }
      const data = await upstash(["SET", PREFIX + key, value]);
      if (data.error) throw new Error(data.error);
      res.status(200).json({ ok: data.result === "OK" });
    } else if (req.method === "DELETE") {
      const key = req.query.key;
      if (!key || typeof key !== "string") {
        res.status(400).json({ error: "kein key übergeben" });
        return;
      }
      const data = await upstash(["DEL", PREFIX + key]);
      if (data.error) throw new Error(data.error);
      res.status(200).json({ deleted: (data.result || 0) > 0 });
    } else {
      res.status(405).json({ error: "Methode nicht erlaubt" });
    }
  } catch (err) {
    res.status(500).json({ error: "Speicher-Fehler", details: String(err) });
  }
}
