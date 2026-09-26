# Schnellladenetz Deutschland

Interaktives Dashboard zum Ladesäulenregister der Bundesnetzagentur. Kernfrage: Verdichtet der weitere Ausbau von DC-Ladepunkten das Netz noch, oder erschließt er neue Fläche?

Statische Seite ohne Build-Schritt: HTML, CSS, D3.js (lokal eingebunden) und ein vorab berechnetes JSON. Keine externen Requests zur Laufzeit, auch keine Google Fonts.

## Inhalt

- **Kennzahlen**: Ladepunkte gesamt, DC-Ladepunkte, DC-Ladeleistung, Median-Abstand neuer DC-Punkte
- **Abstand je Quartal**: Median und mittlere 50 % der Distanz neuer DC-Ladepunkte zur nächsten älteren DC-Ladeeinrichtung
- **Klassenanteile je Jahr**: Erweiterung (< 300 m), Verdichtung (0,3–2 km), Lückenschluss (2–10 km), neue Fläche (> 10 km)
- **Karte** mit Zeitraffer des Ausbaus
- **Versorgungsdistanz**: Entfernung von bewohnten 5-km-Rasterzellen zum nächsten DC-Lader je Jahresende
- **Basisdaten**: Zubau je Quartal (Brush wählt Zeitraum), Leistungsverteilung, Top-Betreiber, Bundesländer

Filter: Bundesland, Leistungsklasse, Referenznetz (alle DC oder nur ≥ 150 kW), Zeitraum.

## Daten aktualisieren

```bash
curl -O https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenregister_BNetzA_2026-09-01.csv
python3 scripts/build_data.py Ladesaeulenregister_BNetzA_2026-09-01.csv
```

Das Skript nutzt nur die Python-Standardbibliothek (ab 3.9) und schreibt `public/data/lsr.json`. Laufzeit rund 30 Sekunden.

## Lokal ansehen

```bash
cd public && python3 -m http.server 8000
```

Dann http://localhost:8000 öffnen. Direktes Öffnen der `index.html` per Doppelklick funktioniert nicht, weil der Browser `fetch` auf lokale Dateien blockiert.

## Veröffentlichen mit GitLab Pages

`.gitlab-ci.yml` veröffentlicht den Ordner `public/` bei jedem Push auf den Default-Branch.

## Methodik und Grenzen

- DC = Ladeeinrichtung mit mindestens einem DC-Stecker (CCS, CHAdeMO, MCS).
- Abstand = Luftlinie (Haversine) zur nächsten DC-Ladeeinrichtung mit strikt früherem Inbetriebnahmedatum. Gewichtung nach Anzahl Ladepunkte.
- Das Register enthält nur aktuell betriebene, vollständig gemeldete Einrichtungen. Abgebaute Säulen fehlen (Survivorship), jüngste Monate sind wegen Meldeverzug unvollständig.

## Lizenzen

- Daten: Bundesnetzagentur, Ladesäulenregister, CC BY 4.0 (Quellenangabe ist im Dashboard-Footer).
- D3.js: ISC-Lizenz, `public/vendor/d3-LICENSE.txt`
- Hanken Grotesk: SIL Open Font License 1.1, `public/fonts/OFL-LICENSE.txt`
