
// Vercel Serverless Function: leitet Anfragen an die Rebrickable API weiter.
// Löst das CORS-Problem, das direkte Browser-Aufrufe an rebrickable.com verhindert.
// Der Rebrickable-API-Key kommt vom Client selbst (eigener Key, kein Geheimnis das
// versteckt werden müsste) und wird per Header durchgereicht.

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Nur GET erlaubt" });
    return;
  }

  const key = req.headers["x-rb-key"];
  const path = req.query.path;

  if (!key) {
    res.status(400).json({ error: "Kein Rebrickable-API-Key übergeben" });
    return;
  }
  if (!path || typeof path !== "string" || !path.startsWith("/api/v3/lego/")) {
    res.status(400).json({ error: "Ungültiger Anfrage-Pfad" });
    return;
  }

  try {
    const rbRes = await fetch(`https://rebrickable.com${path}`, {
      headers: { Authorization: `key ${key}` },
    });
    const data = await rbRes.json();
    res.status(rbRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Proxy-Fehler", details: String(err) });
  }
}
