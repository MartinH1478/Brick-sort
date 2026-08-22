// Vercel Serverless Function: leitet Anfragen an die Anthropic API weiter.
// Der API-Key bleibt server-seitig (Umgebungsvariable ANTHROPIC_API_KEY bei Vercel
// eintragen) und wird nie an den Browser ausgeliefert. Löst nebenbei auch das
// CORS-Problem, das direkte Browser-Aufrufe an api.anthropic.com verhindern würde.

// PDF-/Teileliste-Analysen können länger als die Standard-10s dauern - Limit auf das
// beim kostenlosen Vercel-Plan maximal mögliche (60s) anheben.
export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Nur POST erlaubt" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY ist nicht als Umgebungsvariable gesetzt" });
    return;
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await anthropicRes.json();
    res.status(anthropicRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Proxy-Fehler", details: String(err) });
  }
}
