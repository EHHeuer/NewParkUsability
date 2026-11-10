#!/usr/bin/env python3
"""Wandelt das Ladesäulenregister im Excel-Format in die CSV-Form um, die
build_data.py erwartet (Semikolon, Dezimalkomma, Datum TT.MM.JJJJ).

Die BNetzA veröffentlicht neuere Stände teils nur noch als .xlsx.
Benötigt openpyxl (pip install openpyxl).

    python3 scripts/xlsx_to_csv.py Ladesaeulenregister_BNetzA_2026-09-30.xlsx
"""
import csv
import datetime
import os
import sys

import openpyxl


def cell(v):
    if v is None:
        return ""
    if isinstance(v, datetime.datetime):
        return v.strftime("%d.%m.%Y")
    if isinstance(v, float):
        return (f"{v:.6f}".rstrip("0").rstrip(".")).replace(".", ",")
    return str(v)


def main(src, dst):
    wb = openpyxl.load_workbook(src, read_only=True)
    ws = wb[wb.sheetnames[0]]
    with open(dst, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        n = 0
        for row in ws.iter_rows(values_only=True):
            w.writerow([cell(v) for v in row])
            n += 1
    print(f"{n} Zeilen -> {dst}")


if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0] + ".csv"
    main(src, dst)
