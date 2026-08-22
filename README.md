# Brick Sorter — eigenständige PWA

LEGO-Teile per Foto oder Live-Kamera scannen, mit den eigenen Sets (aus PDF-Bauanleitungen)
abgleichen und Fehlteile-Übersicht führen. Läuft als installierbare Web-App (PWA), keine
Claude-Umgebung mehr nötig.

## Was du brauchst

1. Einen kostenlosen [GitHub](https://github.com)-Account
2. Einen kostenlosen [Vercel](https://vercel.com)-Account (Anmeldung direkt mit GitHub möglich)
3. Einen Anthropic-API-Key von **https://console.anthropic.com** → "API Keys" → "Create Key"
   (nötig für die KI-Funktionen: Teil-Erkennung, PDF-Auslesung, Set-Abgleich — läuft
   nutzungsbasiert, kein Abo)

## Einmalige Einrichtung

### 1. Projekt zu GitHub hochladen

```bash
cd brick-sorter-pwa
git init
git add .
git commit -m "Brick Sorter"
```

Dann bei GitHub ein neues, leeres Repository anlegen und pushen:

```bash
git remote add origin https://github.com/<dein-username>/brick-sorter.git
git push -u origin main
```

### 2. Bei Vercel deployen

1. Auf [vercel.com](https://vercel.com) einloggen → "Add New" → "Project"
2. Das gerade erstellte GitHub-Repository auswählen → "Import"
3. Vercel erkennt Vite automatisch — bei "Environment Variables" jetzt eintragen:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Wert:** dein Key von console.anthropic.com
4. "Deploy" klicken — nach ca. 1 Minute ist die App live unter einer URL wie
   `https://brick-sorter-deinname.vercel.app`

### 3. Auf dem Handy installieren

1. Die Vercel-URL in **Chrome** (Android) bzw. **Safari** (iOS) öffnen
2. Android: Menü (⋮) → "App installieren" bzw. "Zum Startbildschirm hinzufügen"
3. iOS: Teilen-Symbol → "Zum Home-Bildschirm"
4. Die App startet danach im Vollbild, mit eigenem Icon, wie eine normale App

## Live-Kamera-Scan

Im Scan-Screen zwischen "Einzelfoto" und "Live-Scan" umschalten. Im Live-Modus fragt der
Browser einmalig nach Kamera-Erlaubnis — das funktioniert hier normal (anders als in der
Claude-Artifact-Vorschau), weil die App nicht mehr in einem eingebetteten iFrame läuft.

## Lokal testen (optional, vor dem Deployen)

```bash
npm install
npm run dev
```

Öffnet die App unter `http://localhost:5173`. Die KI-Funktionen brauchen dafür zusätzlich
eine lokale `.env`-Datei mit `ANTHROPIC_API_KEY=dein-key` sowie `vercel dev` statt `npm run dev`,
damit die Serverless-Funktion unter `/api/claude` mitläuft (`npm i -g vercel`, dann `vercel dev`).

## Daten & Geräte

Alle Daten (Sets, Teilelisten, Fortschritt) liegen im lokalen Speicher deines Browsers/Geräts
— nichts wird automatisch zwischen Geräten synchronisiert. Für einen Gerätewechsel: im Tool
unter "Übersicht" → "Sicherung" herunterladen, auf dem anderen Gerät über "Laden" wieder
einspielen.

## Kosten

- Vercel Hosting: kostenlos im Hobby-Plan
- Anthropic API: nutzungsbasiert, nur für tatsächliche Scans/PDF-Analysen (kein Abo, keine
  Fixkosten)
