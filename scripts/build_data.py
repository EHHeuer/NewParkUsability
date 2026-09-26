#!/usr/bin/env python3
"""Bereitet das Ladesäulenregister der Bundesnetzagentur für das Dashboard auf.

Nur Standardbibliothek, damit das Skript auch in einem schlanken CI-Image läuft.

    python3 scripts/build_data.py Ladesaeulenregister_BNetzA_2026-09-01.csv

Erzeugt public/data/lsr.json. Kernstück ist die Abstandsanalyse: Für jede
DC-Ladeeinrichtung wird der Abstand zur nächsten DC-Ladeeinrichtung bestimmt,
die *vor* ihr in Betrieb ging (strikt früheres Inbetriebnahmedatum). Zusätzlich
wird dasselbe gegen das Teilnetz mit >= 150 kW (HPC) gerechnet und für ein
5-km-Raster die Entfernung zum nächsten DC-Standort je Jahresende.
"""
import csv
import io
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import date

HPC_KW = 150
CELL_DEG_LAT = 0.045  # ~5 km
YEARS = list(range(2012, 2027))
BASE_YEAR = 2000  # Monatsindex m = (Jahr - 2000) * 12 + (Monat - 1)

EARTH_R = 6371000.0


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


class Grid:
    """Einfacher räumlicher Hash für inkrementelles Nearest-Neighbour-Suchen."""

    def __init__(self, cell_deg=0.05):
        self.c = cell_deg
        self.cells = defaultdict(list)
        self.pts = []
        self.n = 0

    def key(self, lat, lon):
        return int(math.floor(lat / self.c)), int(math.floor(lon / self.c))

    def add(self, lat, lon):
        self.cells[self.key(lat, lon)].append((lat, lon))
        self.pts.append((lat, lon))
        self.n += 1

    def nearest(self, lat, lon, max_ring=60):
        if self.n == 0:
            return None
        if self.n < 1500:  # dünn besetzt: Ringsuche wäre teurer als Brute Force
            return min(haversine(lat, lon, a, b) for a, b in self.pts)
        ki, kj = self.key(lat, lon)
        best = None
        # Ein Ring in Breitengrad ~5.5 km, in Längengrad ~3.5 km (bei 51° N).
        ring_m = self.c * 111320 * math.cos(math.radians(55))
        for r in range(max_ring + 1):
            if best is not None and best < (r - 1) * ring_m:
                break
            for i in range(ki - r, ki + r + 1):
                for j in range(kj - r, kj + r + 1):
                    if max(abs(i - ki), abs(j - kj)) != r:
                        continue
                    for (a, b) in self.cells.get((i, j), ()):
                        d = haversine(lat, lon, a, b)
                        if best is None or d < best:
                            best = d
        return best


def fnum(s):
    s = (s or "").strip().replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def main(path, out):
    with open(path, encoding="utf-8-sig", newline="") as f:
        raw = f.read()
    lines = raw.splitlines(keepends=True)
    hdr = next(i for i, l in enumerate(lines) if l.startswith("Ladeeinrichtungs-ID"))
    stand = re.search(r"Letzte Aktualisierung vom: (\d\d\.\d\d\.\d{4})", raw)
    stand = stand.group(1) if stand else None
    reader = csv.reader(io.StringIO("".join(lines[hdr:])), delimiter=";")
    cols = next(reader)
    ix = {c: i for i, c in enumerate(cols)}

    bl_names, op_names = [], []
    bl_idx, op_idx = {}, {}

    def idx(table, names, v):
        if v not in table:
            table[v] = len(names)
            names.append(v)
        return table[v]

    rows = []
    for r in reader:
        if len(r) < len(cols) or not r[0].strip():
            continue
        try:
            d, mo, y = (int(x) for x in r[ix["Inbetriebnahmedatum"]].split("."))
        except ValueError:
            continue
        lat, lon = fnum(r[ix["Breitengrad"]]), fnum(r[ix["Längengrad"]])
        if lat is None or lon is None or not (47 < lat < 55.2 and 5.5 < lon < 15.5):
            continue
        plugs = " ".join(r[ix[f"Steckertypen{k}"]] for k in range(1, 7))
        kw = fnum(r[ix["Nennleistung Ladeeinrichtung [kW]"]]) or 0.0
        lp = int(fnum(r[ix["Anzahl Ladepunkte"]]) or 1)
        rows.append(dict(
            day=date(y, mo, d).toordinal(),
            m=(y - BASE_YEAR) * 12 + (mo - 1),
            lat=lat, lon=lon, kw=kw, lp=lp,
            dc="DC" in plugs,
            bl=idx(bl_idx, bl_names, r[ix["Bundesland"]].strip()),
            op=r[ix["Betreiber"]].strip(),
        ))

    dc = sorted((r for r in rows if r["dc"]), key=lambda r: r["day"])
    ac = [r for r in rows if not r["dc"]]

    # Betreiber nur für DC, nach Anzahl DC-Ladepunkte sortiert
    op_count = defaultdict(int)
    for r in dc:
        op_count[r["op"]] += r["lp"]
    for name, _ in sorted(op_count.items(), key=lambda kv: -kv[1]):
        idx(op_idx, op_names, name)

    # --- Abstand zur nächsten älteren DC-Ladeeinrichtung -------------------
    g_all, g_hpc = Grid(), Grid()
    i = 0
    while i < len(dc):
        j = i
        while j < len(dc) and dc[j]["day"] == dc[i]["day"]:
            j += 1
        batch = dc[i:j]
        for r in batch:  # erst alle vom selben Tag abfragen, dann einfügen
            r["da"] = g_all.nearest(r["lat"], r["lon"])
            r["dh"] = g_hpc.nearest(r["lat"], r["lon"])
        for r in batch:
            g_all.add(r["lat"], r["lon"])
            if r["kw"] >= HPC_KW:
                g_hpc.add(r["lat"], r["lon"])
        i = j

    def dist_out(v):
        return -1 if v is None else int(round(v))

    dc_out = dict(
        m=[r["m"] for r in dc],
        lat=[round(r["lat"] * 1e4) for r in dc],
        lon=[round(r["lon"] * 1e4) for r in dc],
        kw=[round(r["kw"]) for r in dc],
        lp=[r["lp"] for r in dc],
        bl=[r["bl"] for r in dc],
        op=[op_idx[r["op"]] for r in dc],
        da=[dist_out(r["da"]) for r in dc],
        dh=[dist_out(r["dh"]) for r in dc],
    )

    # --- AC: Monatsaggregate und ausgedünnte Punkte für die Karte -----------
    agg = defaultdict(lambda: [0, 0, 0.0])
    dots = {}
    for r in ac:
        a = agg[(r["m"], r["bl"])]
        a[0] += 1
        a[1] += r["lp"]
        a[2] += r["kw"]
        k = (round(r["lat"] / 0.01), round(r["lon"] / 0.015))
        if k not in dots or dots[k][0] > r["m"]:
            dots[k] = (r["m"], r["bl"])
    ac_agg = [[m, bl, n, lp, round(kw)] for (m, bl), (n, lp, kw) in sorted(agg.items())]
    ac_dots = dict(
        lat=[round(k[0] * 0.01 * 1e4) for k in dots],
        lon=[round(k[1] * 0.015 * 1e4) for k in dots],
        m=[v[0] for v in dots.values()],
        bl=[v[1] for v in dots.values()],
    )

    # --- Versorgungsraster: Entfernung Rasterzelle -> nächster DC je Jahr ---
    # Zellen = 5-km-Raster, in dem heute mindestens eine Ladeeinrichtung steht
    # (Näherung für besiedelte Fläche). Bundesland = häufigstes in der Zelle.
    lon_step = CELL_DEG_LAT / math.cos(math.radians(51))
    cell_bl = defaultdict(lambda: defaultdict(int))
    for r in rows:
        k = (int(r["lat"] // CELL_DEG_LAT), int(r["lon"] // lon_step))
        cell_bl[k][r["bl"]] += 1
    cells = sorted(cell_bl)
    centers = [((a + 0.5) * CELL_DEG_LAT, (b + 0.5) * lon_step) for a, b in cells]
    cov_da, cov_dh = [], []
    di = 0
    ga, gh = Grid(), Grid()
    for y in YEARS:
        end = date(y, 12, 31).toordinal()
        while di < len(dc) and dc[di]["day"] <= end:
            ga.add(dc[di]["lat"], dc[di]["lon"])
            if dc[di]["kw"] >= HPC_KW:
                gh.add(dc[di]["lat"], dc[di]["lon"])
            di += 1
        cov_da.append([round((ga.nearest(la, lo, 120) or 0) / 100) for la, lo in centers])
        cov_dh.append([round((gh.nearest(la, lo, 120) or 0) / 100) if gh.n else -1
                       for la, lo in centers])
    cov = dict(
        years=YEARS,
        lat=[round(c[0] * 1e4) for c in centers],
        lon=[round(c[1] * 1e4) for c in centers],
        bl=[max(cell_bl[k].items(), key=lambda kv: kv[1])[0] for k in cells],
        da=cov_da,  # [Jahr][Zelle] in 100 m
        dh=cov_dh,
    )

    out_obj = dict(
        meta=dict(
            stand=stand,
            source="Bundesnetzagentur, Ladesäulenregister",
            license="CC BY 4.0",
            baseYear=BASE_YEAR,
            hpcKw=HPC_KW,
            nRows=len(rows),
        ),
        bl=bl_names,
        op=op_names,
        dc=dc_out,
        acAgg=ac_agg,
        acDots=ac_dots,
        cov=cov,
    )
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(out_obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(rows)} Ladeeinrichtungen, {len(dc)} DC, {len(ac_dots['m'])} AC-Punkte, "
          f"{len(cells)} Rasterzellen -> {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "Ladesaeulenregister.csv"
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(__file__), "..", "public", "data", "lsr.json")
    main(src, dst)
