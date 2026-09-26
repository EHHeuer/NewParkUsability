/* Schnellladenetz Deutschland – Dashboard
 * Daten: Bundesnetzagentur, Ladesäulenregister (aufbereitet durch scripts/build_data.py)
 */
(() => {
  "use strict";

  const locale = d3.formatLocale({ decimal: ",", thousands: ".", grouping: [3], currency: ["", " €"] });
  const fmtInt = locale.format(",.0f");
  const fmt1 = locale.format(",.1f");
  const fmtPct = locale.format(".0%");
  const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

  const css = getComputedStyle(document.documentElement);
  const cv = (n) => css.getPropertyValue(n).trim();
  const COL = {
    dc: cv("--dc"), ac: cv("--ac"), ghost: cv("--ghost"), surface: cv("--surface"), ink: cv("--ink"),
    cls: [cv("--c0"), cv("--c1"), cv("--c2"), cv("--c3")],
    pw: [cv("--p0"), cv("--p1"), cv("--p2"), cv("--p3")],
  };
  const CLASS_NAMES = ["Am Bestand", "Verdichtung", "Lückenschluss", "Neue Fläche"];
  const CLASS_RANGES = ["unter 300 m", "300 m – 2 km", "2 – 10 km", "über 10 km"];
  const CLASS_LIMITS = [300, 2000, 10000];
  const PW_NAMES = ["unter 50 kW", "50 – 149 kW", "150 – 299 kW", "ab 300 kW"];
  const PW_SHORT = ["< 50", "50–149", "150–299", "≥ 300 kW"];

  const DUR = 750;
  const ease = d3.easeCubicInOut;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tr = (animate) => (animate && !reduceMotion ? d3.transition().duration(DUR).ease(ease) : null);

  let D; // aufbereitete Daten
  const state = { bl: -1, kw: [true, true, true, true], ref: "da", from: 2015, to: 2026, mapT: 0, pampaKm: 10 };
  const PAMPA_MONTHS = 3;
  let DEFAULT_FROM = 2015;

  const $ = (s) => document.querySelector(s);

  // --------------------------------------------------------------------------
  // Hilfsfunktionen
  // --------------------------------------------------------------------------
  const classOf = (d) => (d < 0 ? 3 : d < CLASS_LIMITS[0] ? 0 : d < CLASS_LIMITS[1] ? 1 : d < CLASS_LIMITS[2] ? 2 : 3);
  const pwOf = (kw) => (kw < 50 ? 0 : kw < 150 ? 1 : kw < 300 ? 2 : 3);
  const yearOfM = (m) => D.base + Math.floor(m / 12);
  const qLabel = (q) => `${D.base + Math.floor(q / 4)} Q${(q % 4) + 1}`;
  const mLabel = (m) => `${MONTHS[m % 12]} ${D.base + Math.floor(m / 12)}`;

  function fmtDist(m) {
    if (!isFinite(m)) return "–";
    if (m < 1000) return `${fmtInt(Math.round(m / 10) * 10)} m`;
    if (m < 10000) return `${fmt1(m / 1000)} km`;
    return `${fmtInt(m / 1000)} km`;
  }
  const fmtTick = (m) => (m < 1000 ? `${m} m` : `${m / 1000} km`);
  function fmtCompact(n) {
    if (n >= 1e6) return `${fmt1(n / 1e6)} Mio.`;
    return fmtInt(n);
  }
  function shortOp(name) {
    return name
      .replace(/\s*(GmbH|AG|SE|mbH|KG|Co\.?\s?KG|und Co\.?\s?KG|& Co\.?\s?KG|Gesellschaft für.*|Deutschland|Germany)\b\.?/gi, " ")
      .replace(/\s+/g, " ").replace(/[\s,&-]+$/, "").trim() || name;
  }

  function wQuantiles(vals, wts, qs) {
    const idx = d3.range(vals.length).sort((a, b) => vals[a] - vals[b]);
    const total = d3.sum(wts);
    const out = [];
    let acc = 0, k = 0;
    for (const q of qs) {
      const target = q * total;
      while (k < idx.length && acc + wts[idx[k]] < target) { acc += wts[idx[k]]; k++; }
      out.push(k < idx.length ? vals[idx[k]] : NaN);
    }
    return out;
  }

  function roundedTop(x, y, w, h, r) {
    if (h <= 0 || w <= 0) return `M${x},${y + h}h${w}v0h${-w}Z`;
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /* Linien/Flächen weich zwischen zwei Zuständen interpolieren. pts: [[x, y, y1?]] oder null */
  function tweenPath(path, pts, gen, t) {
    const node = path.node();
    const prev = node.__pts;
    node.__pts = pts;
    if (!t || !prev || prev.length !== pts.length) { path.attr("d", gen(pts)); return; }
    path.transition(t).attrTween("d", () => (u) =>
      gen(pts.map((p, i) => {
        const a = prev[i];
        if (!p || !a || !p.every(isFinite) || !a.every(isFinite)) return p;
        return p.map((v, j) => a[j] + (v - a[j]) * u);
      })));
  }

  function tweenNumber(el, value, formatter, animate) {
    const node = typeof el === "string" ? $(el) : el;
    const from = node.__v ?? 0;
    node.__v = value;
    if (!animate || reduceMotion || !isFinite(from) || !isFinite(value)) { node.textContent = formatter(value); return; }
    d3.select(node).transition().duration(DUR).ease(ease)
      .tween("text", () => { const i = d3.interpolateNumber(from, value); return (u) => { node.textContent = formatter(i(u)); }; });
  }

  // Tooltip -----------------------------------------------------------------
  const tip = $("#tooltip");
  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.classList.add("on");
    const pad = 14, r = tip.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  const hideTip = () => tip.classList.remove("on");
  const ttRow = (k, v, col) => `<div class="tt-r"><span class="tt-k">${col ? `<i class="sw" style="background:${col}"></i>` : ""}${k}</span><b>${v}</b></div>`;

  function legend(sel, items, kind = "") {
    $(sel).innerHTML = items.map(([name, col, extra]) =>
      `<span class="legend-item"><i class="sw ${kind}" style="background:${col}"></i>${name}${extra ? ` <span class="muted">${extra}</span>` : ""}</span>`).join("");
  }

  // Chart-Grundgerüst ------------------------------------------------------
  function frame(id, margin) {
    const el = $(id);
    const svg = d3.select(el).append("svg");
    const g = svg.append("g");
    const obj = { el, svg, g, margin, w: 0, h: 0 };
    obj.measure = () => {
      const W = el.clientWidth;
      const H = parseFloat(getComputedStyle(el).minHeight) || 260;
      svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
      g.attr("transform", `translate(${margin.l},${margin.t})`);
      obj.w = Math.max(10, W - margin.l - margin.r);
      obj.h = Math.max(10, H - margin.t - margin.b);
      return obj;
    };
    return obj;
  }

  // --------------------------------------------------------------------------
  // Daten vorbereiten
  // --------------------------------------------------------------------------
  function prepare(raw) {
    const dc = raw.dc, n = dc.m.length;
    const pc = new Uint8Array(n), yr = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      pc[i] = pwOf(dc.kw[i]);
      yr[i] = raw.meta.baseYear + Math.floor(dc.m[i] / 12);
    }
    // Ladeparks: Einheit der Abstandsanalyse
    const pk = raw.parks, np = pk.m.length;
    const P = { ...pk, n: np, pc: new Uint8Array(np), clsA: new Uint8Array(np), clsH: new Uint8Array(np), yr: new Uint16Array(np) };
    for (let i = 0; i < np; i++) {
      P.pc[i] = pwOf(pk.kw[i]);
      P.clsA[i] = classOf(pk.da[i]);
      P.clsH[i] = classOf(pk.dh[i]);
      P.yr[i] = raw.meta.baseYear + Math.floor(pk.m[i] / 12);
    }
    // 15 größte Betreiber nach DC-Ladepunkten (bundesweit, fest, damit die Auswahl beim Filtern stabil bleibt)
    const opLp = new Map();
    for (let i = 0; i < n; i++) opLp.set(dc.op[i], (opLp.get(dc.op[i]) || 0) + dc.lp[i]);
    const topOps = [...opLp].sort((a, b) => b[1] - a[1]).slice(0, 15).map((d) => d[0]);
    const lastM = d3.max(dc.m);
    return {
      raw, base: raw.meta.baseYear, bl: raw.bl, op: raw.op, ort: raw.ort, dc, n, pc, yr, P, topOps, lastM,
      lastYear: raw.meta.baseYear + Math.floor(lastM / 12),
      firstYear: 2012,
      ac: raw.acAgg, acDots: raw.acDots, cov: raw.cov,
    };
  }

  const inBl = (b) => state.bl < 0 || b === state.bl;
  const clsArr = () => (state.ref === "da" ? D.P.clsA : D.P.clsH);
  const distArr = () => (state.ref === "da" ? D.P.da : D.P.dh);

  // --------------------------------------------------------------------------
  // Filter-UI
  // --------------------------------------------------------------------------
  function setupFilters() {
    const sel = $("#f-bl");
    D.bl.map((name, i) => [name, i]).sort((a, b) => a[0].localeCompare(b[0], "de"))
      .forEach(([name, i]) => sel.insertAdjacentHTML("beforeend", `<option value="${i}">${name}</option>`));
    sel.addEventListener("change", () => { state.bl = +sel.value; update(true); });

    const kwBox = $("#f-kw");
    kwBox.innerHTML = PW_SHORT.map((s, i) =>
      `<button type="button" data-i="${i}" aria-pressed="true"><i class="sw" style="background:${COL.pw[i]}"></i>${s}</button>`).join("");
    kwBox.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const i = +b.dataset.i;
      const on = state.kw.filter(Boolean).length;
      if (state.kw[i] && on === 1) state.kw = [true, true, true, true]; // letzter aktiver: alle wieder an
      else if (on === 4) state.kw = state.kw.map((_, k) => k === i); // aus "alle" heraus: nur diese
      else state.kw[i] = !state.kw[i];
      syncFilters(); update(true);
    });

    $("#f-ref").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.ref = b.dataset.v; syncFilters(); update(true);
    });

    const from = $("#f-from"), to = $("#f-to");
    for (const inp of [from, to]) { inp.min = D.firstYear; inp.max = D.lastYear; inp.step = 1; }
    const onRange = (e) => {
      let a = +from.value, b = +to.value;
      if (a > b) { if (e.target === from) b = a; else a = b; }
      if (a === state.from && b === state.to) return;
      state.from = a; state.to = b; syncFilters(); scheduleUpdate();
    };
    from.addEventListener("input", onRange);
    to.addEventListener("input", onRange);

    $("#f-reset").addEventListener("click", () => {
      Object.assign(state, { bl: -1, kw: [true, true, true, true], ref: "da", from: DEFAULT_FROM, to: D.lastYear });
      syncFilters(); update(true);
    });
  }

  let rafPending = null;
  function scheduleUpdate() {
    if (rafPending) clearTimeout(rafPending);
    rafPending = setTimeout(() => { rafPending = null; update(true); }, 90);
  }

  function syncFilters() {
    $("#f-bl").value = state.bl;
    document.querySelectorAll("#f-kw button").forEach((b, i) => b.setAttribute("aria-pressed", state.kw[i]));
    document.querySelectorAll("#f-ref button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === state.ref));
    const from = $("#f-from"), to = $("#f-to");
    from.value = state.from; to.value = state.to;
    const span = D.lastYear - D.firstYear;
    const fill = $(".range-fill");
    fill.style.left = `${((state.from - D.firstYear) / span) * 100}%`;
    fill.style.right = `${100 - ((state.to - D.firstYear) / span) * 100}%`;
    $("#f-range-out").textContent = state.from === state.to ? `${state.from}` : `${state.from} – ${state.to}`;
    // Der obere Regler muss greifbar bleiben, wenn beide rechts stehen
    from.style.zIndex = state.from >= D.lastYear - 1 ? 3 : 1;
  }

  // --------------------------------------------------------------------------
  // Aggregationen
  // --------------------------------------------------------------------------
  function selPark() {
    // Ladeparks, die Bundesland- und Leistungsfilter erfüllen (Leistung = stärkste Einrichtung im Park)
    const out = [], P = D.P;
    for (let i = 0; i < P.n; i++) if (inBl(P.bl[i]) && state.kw[P.pc[i]]) out.push(i);
    return out;
  }

  function selDC() {
    // Indizes der DC-Einrichtungen, die Bundesland- und Leistungsfilter erfüllen
    const out = [];
    const { dc } = D;
    for (let i = 0; i < D.n; i++) if (inBl(dc.bl[i]) && state.kw[D.pc[i]]) out.push(i);
    return out;
  }

  // --------------------------------------------------------------------------
  // 1 · Abstand je Quartal
  // --------------------------------------------------------------------------
  const cDist = { f: null };
  function initDist() {
    const f = cDist.f = frame("#c-dist", { t: 14, r: 108, b: 30, l: 52 });
    f.g.append("clipPath").attr("id", "clip-dist").append("rect");
    f.gClass = f.g.append("g");
    f.gGrid = f.g.append("g").attr("class", "gridline");
    f.gY = f.g.append("g").attr("class", "axis");
    f.gX = f.g.append("g").attr("class", "axis");
    f.base = f.g.append("line").attr("class", "baseline");
    const plot = f.g.append("g").attr("clip-path", "url(#clip-dist)");
    f.band = plot.append("path").attr("fill", COL.dc).attr("fill-opacity", 0.1);
    f.line = plot.append("path").attr("fill", "none").attr("stroke", COL.dc).attr("stroke-width", 2).attr("stroke-linejoin", "round").attr("stroke-linecap", "round");
    f.endDot = f.g.append("circle").attr("r", 4.5).attr("fill", COL.dc).attr("stroke", COL.surface).attr("stroke-width", 2);
    f.endLbl = f.g.append("text").attr("class", "lbl-strong").attr("dy", "0.35em");
    f.hLine = f.g.append("line").attr("class", "hover-line").style("opacity", 0);
    f.hDot = f.g.append("circle").attr("r", 4.5).attr("fill", COL.dc).attr("stroke", COL.surface).attr("stroke-width", 2).style("opacity", 0);
    f.overlay = f.g.append("rect").attr("fill", "transparent");
  }

  function renderDist(animate) {
    const f = cDist.f.measure();
    const t = tr(animate);
    const dist = distArr();
    const q0 = (D.firstYear - D.base) * 4, q1 = Math.floor(D.lastM / 3);
    const buckets = new Map();
    for (const i of selPark()) {
      const d = dist[i];
      if (d < 0) continue;
      const q = Math.floor(D.P.m[i] / 3);
      if (q < q0) continue;
      let b = buckets.get(q); if (!b) buckets.set(q, (b = { v: [], w: [] }));
      b.v.push(Math.max(d, 12)); b.w.push(1);
    }
    const quarters = d3.range(q0, q1 + 1).map((q) => {
      const b = buckets.get(q);
      const n = b ? d3.sum(b.w) : 0;
      if (n < 8) return { q, n, med: NaN, p25: NaN, p75: NaN };
      const [p25, med, p75] = wQuantiles(b.v, b.w, [0.25, 0.5, 0.75]);
      return { q, n, med, p25, p75 };
    });
    cDist.data = quarters;

    const xa = (state.from - D.base) * 4, xb = (state.to - D.base) * 4 + 3;
    const x = d3.scaleLinear().domain([xa - 0.5, Math.min(xb, q1) + 0.5]).range([0, f.w]);
    const y = d3.scaleLog().domain([20, 60000]).range([f.h, 0]).clamp(true);
    cDist.x = x; cDist.y = y;

    f.g.select("#clip-dist rect").attr("x", 0).attr("y", -10).attr("width", f.w + 1).attr("height", f.h + 20);

    // Klassen-Schwellen als feine Bänder mit Beschriftung rechts
    const bands = [[20, 300], [300, 2000], [2000, 10000], [10000, 60000]];
    const bandSel = f.gClass.selectAll("g.cband").data(bands).join((enter) => {
      const g = enter.append("g").attr("class", "cband");
      g.append("rect").attr("x", 0).attr("width", 3).attr("rx", 1.5);
      g.append("text").attr("class", "annot").attr("dy", "0.35em");
      return g;
    });
    bandSel.select("rect").attr("fill", (_, i) => COL.cls[i]).attr("transform", `translate(${f.w + 12},0)`)
      .attr("y", (d) => y(d[1]) + 1).attr("height", (d) => Math.max(0, y(d[0]) - y(d[1]) - 2));
    bandSel.select("text").attr("x", f.w + 22).attr("y", (d) => (y(d[0]) + y(d[1])) / 2).text((_, i) => CLASS_NAMES[i]);

    const ticks = [100, 300, 1000, 2000, 10000];
    f.gGrid.selectAll("line").data(ticks).join("line").attr("x1", 0).attr("x2", f.w).attr("y1", (d) => Math.round(y(d)) + 0.5).attr("y2", (d) => Math.round(y(d)) + 0.5);
    f.gY.selectAll("text").data(ticks).join("text").attr("x", -10).attr("y", (d) => y(d)).attr("dy", "0.35em").attr("text-anchor", "end").text(fmtTick);
    f.base.attr("x1", 0).attr("x2", f.w).attr("y1", f.h + 0.5).attr("y2", f.h + 0.5);

    const years = d3.range(state.from, Math.min(state.to, D.lastYear) + 1);
    const every = Math.ceil(years.length / Math.max(2, Math.floor(f.w / 64)));
    const yx = years.filter((_, i) => i % every === 0);
    const xt = f.gX.attr("transform", `translate(0,${f.h + 20})`).selectAll("text").data(yx, (d) => d);
    xt.join(
      (e) => e.append("text").attr("text-anchor", "middle").attr("x", (d) => x((d - D.base) * 4 + 1.5)).style("opacity", 0).text((d) => d),
      (u) => u, (ex) => ex.transition(t).style("opacity", 0).remove()
    ).transition(t).attr("x", (d) => x((d - D.base) * 4 + 1.5)).style("opacity", 1);

    const pts = quarters.map((d) => [x(d.q), isFinite(d.med) ? y(d.med) : NaN]);
    const bpts = quarters.map((d) => [x(d.q), isFinite(d.p25) ? y(d.p25) : NaN, isFinite(d.p75) ? y(d.p75) : NaN]);
    tweenPath(f.line, pts, d3.line().defined((p) => p && isFinite(p[1])).curve(d3.curveMonotoneX), t);
    tweenPath(f.band, bpts, d3.area().defined((p) => p && isFinite(p[1]) && isFinite(p[2])).x((p) => p[0]).y0((p) => p[1]).y1((p) => p[2]).curve(d3.curveMonotoneX), t);

    const vis = quarters.filter((d) => isFinite(d.med) && d.q >= xa && d.q <= xb);
    const last = vis[vis.length - 1];
    const endSel = [f.endDot, f.endLbl];
    if (last) {
      const ex = x(last.q), ey = y(last.med);
      (t ? f.endDot.transition(t) : f.endDot).attr("cx", ex).attr("cy", ey).style("opacity", 1);
      (t ? f.endLbl.transition(t) : f.endLbl).attr("x", ex + 9).attr("y", ey).style("opacity", 1);
      f.endLbl.text(fmtDist(last.med));
    } else endSel.forEach((s) => s.style("opacity", 0));

    f.overlay.attr("width", f.w).attr("height", f.h)
      .on("pointermove", (ev) => {
        const [mx] = d3.pointer(ev);
        const q = Math.round(x.invert(mx));
        const d = quarters.find((e) => e.q === q);
        if (!d || !isFinite(d.med) || q < xa || q > xb) { onLeave(); return; }
        f.hLine.attr("x1", x(q)).attr("x2", x(q)).attr("y1", 0).attr("y2", f.h).style("opacity", 1);
        f.hDot.attr("cx", x(q)).attr("cy", y(d.med)).style("opacity", 1);
        const partial = q === Math.floor(D.lastM / 3) && D.lastM % 3 !== 2;
        showTip(`<div class="tt-h">${qLabel(q)}${partial ? " · unvollständig" : ""}</div>` +
          ttRow("Median", fmtDist(d.med), COL.dc) + ttRow("Mittlere 50 %", `${fmtDist(d.p25)} – ${fmtDist(d.p75)}`) +
          ttRow("Neue Ladeparks", fmtInt(d.n)), ev);
      })
      .on("pointerleave", onLeave);
    function onLeave() { f.hLine.style("opacity", 0); f.hDot.style("opacity", 0); hideTip(); }
  }

  // --------------------------------------------------------------------------
  // 2 · Klassenanteile je Jahr (100 % gestapelt)
  // --------------------------------------------------------------------------
  const cClass = {};
  function initClass() {
    const f = cClass.f = frame("#c-class", { t: 12, r: 8, b: 30, l: 40 });
    f.gGrid = f.g.append("g").attr("class", "gridline");
    f.gY = f.g.append("g").attr("class", "axis");
    f.gBars = f.g.append("g");
    f.gX = f.g.append("g").attr("class", "axis");
    legend("#l-class", CLASS_NAMES.map((n, i) => [`${n}`, COL.cls[i], CLASS_RANGES[i]]));
  }

  function classByYear() {
    const cls = clsArr();
    const rows = new Map();
    for (const i of selPark()) {
      const y = D.P.yr[i];
      if (y < state.from || y > state.to) continue;
      let r = rows.get(y); if (!r) rows.set(y, (r = [0, 0, 0, 0]));
      r[cls[i]] += 1;
    }
    return d3.range(state.from, state.to + 1).map((y) => {
      const c = rows.get(y) || [0, 0, 0, 0];
      const n = d3.sum(c);
      return { y, c, n, s: c.map((v) => (n ? v / n : 0)) };
    });
  }

  function renderClass(animate) {
    const f = cClass.f.measure();
    const t = tr(animate);
    const data = classByYear();
    cClass.data = data;
    const x = d3.scaleBand().domain(data.map((d) => d.y)).range([0, f.w]).paddingInner(0.28).paddingOuter(0.1);
    const bw = Math.min(x.bandwidth(), 56);
    const off = (x.bandwidth() - bw) / 2;
    const y = d3.scaleLinear().domain([0, 1]).range([f.h, 0]);

    f.gGrid.selectAll("line").data([0.25, 0.5, 0.75, 1]).join("line").attr("x1", 0).attr("x2", f.w).attr("y1", (d) => Math.round(y(d)) + 0.5).attr("y2", (d) => Math.round(y(d)) + 0.5);
    f.gY.selectAll("text").data([0, 0.25, 0.5, 0.75, 1]).join("text").attr("x", -10).attr("y", (d) => y(d)).attr("dy", "0.35em").attr("text-anchor", "end").text(fmtPct);

    const every = Math.ceil(data.length / Math.max(2, Math.floor(f.w / 46)));
    f.gX.attr("transform", `translate(0,${f.h + 20})`).selectAll("text").data(data, (d) => d.y).join(
      (e) => e.append("text").attr("text-anchor", "middle").attr("x", (d) => x(d.y) + x.bandwidth() / 2).style("opacity", 0),
      (u) => u, (ex) => ex.remove()
    ).text((d) => (d.y === D.lastYear ? `${d.y}*` : d.y))
      .transition(t).attr("x", (d) => x(d.y) + x.bandwidth() / 2).style("opacity", (_, i) => (i % every === 0 ? 1 : 0));

    const GAP = 2;
    const cols = f.gBars.selectAll("g.col").data(data, (d) => d.y).join(
      (e) => e.append("g").attr("class", "col").attr("transform", (d) => `translate(${x(d.y) + off},0)`).style("opacity", 0),
      (u) => u,
      (ex) => (t ? ex.transition(t).style("opacity", 0).remove() : ex.remove())
    );
    (t ? cols.transition(t) : cols).attr("transform", (d) => `translate(${x(d.y) + off},0)`).style("opacity", 1);

    cols.each(function (d) {
      let acc = 0;
      const segs = d.s.map((s, i) => {
        const y1 = y(acc + s), y0 = y(acc);
        acc += s;
        return { i, s, top: y1, h: y0 - y1, isTop: false };
      });
      const lastIdx = d3.range(3, -1, -1).find((k) => segs[k].s > 0);
      if (lastIdx !== undefined) segs[lastIdx].isTop = true;
      segs.forEach((sg) => { sg.path = sg.isTop ? roundedTop(0, sg.top, bw, Math.max(0, sg.h - (sg.i > 0 ? GAP : 0)), 4)
        : `M0,${sg.top}h${bw}v${Math.max(0, sg.h - (sg.i > 0 ? GAP : 0))}h${-bw}Z`; });
      const g = d3.select(this);
      const p = g.selectAll("path").data(segs, (s) => s.i).join((e) => e.append("path").attr("fill", (s) => COL.cls[s.i]).attr("d", `M0,${f.h}h${bw}v0h${-bw}Z`));
      (t ? p.transition(t) : p).attr("d", (s) => s.path);
      const lbl = g.selectAll("text").data(segs.filter((s) => s.h > 20 && bw > 34), (s) => s.i).join(
        (e) => e.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").style("font", "500 11px var(--font)").attr("x", bw / 2).attr("y", (s) => s.top + s.h / 2).style("opacity", 0)
      );
      lbl.attr("fill", (s) => (s.i >= 2 ? "#FFFFFF" : COL.ink)).text((s) => fmtPct(s.s));
      (t ? lbl.transition(t) : lbl).attr("x", bw / 2).attr("y", (s) => s.top + s.h / 2 - (s.i > 0 ? 1 : 0)).style("opacity", 1);
    });

    cols.on("pointermove", (ev, d) => {
      showTip(`<div class="tt-h">${d.y}${d.y === D.lastYear ? " · bis " + mLabel(D.lastM) : ""}</div>` +
        d3.range(3, -1, -1).map((i) => ttRow(CLASS_NAMES[i], `${fmtPct(d.s[i])} · ${fmtInt(d.c[i])}`, COL.cls[i])).join("") +
        ttRow("Neue Ladeparks", fmtInt(d.n)), ev);
      cols.style("opacity", (e) => (e === d ? 1 : 0.55));
    }).on("pointerleave", () => { hideTip(); cols.style("opacity", 1); });

    // Tabellenansicht
    $("#t-class").innerHTML = `<table><thead><tr><th>Jahr</th>${CLASS_NAMES.map((n) => `<th>${n}</th>`).join("")}<th>Neue Ladeparks</th></tr></thead><tbody>` +
      data.map((d) => `<tr><td>${d.y}</td>${d.s.map((s) => `<td>${fmtPct(s)}</td>`).join("")}<td>${fmtInt(d.n)}</td></tr>`).join("") + "</tbody></table>";
  }

  // --------------------------------------------------------------------------
  // 3 · Karte (Canvas)
  // --------------------------------------------------------------------------
  const map = { playing: false };
  function initMap() {
    const el = $("#c-map");
    map.el = el;
    map.canvas = el.querySelector("canvas");
    map.ctx = map.canvas.getContext("2d");
    const slider = $("#map-t");
    slider.min = (D.firstYear - D.base) * 12; slider.max = D.lastM; slider.step = 1;
    state.mapT = D.lastM;
    slider.value = state.mapT;
    slider.addEventListener("input", () => { stopPlay(); state.mapT = +slider.value; drawMap(); });
    $("#map-play").addEventListener("click", () => (map.playing ? stopPlay() : startPlay()));
    legend("#l-map", []);
    map.canvas.addEventListener("pointermove", mapHover);
    map.canvas.addEventListener("pointerleave", () => { hideTip(); map.hover = null; drawMap(); });
  }

  function layoutMap() {
    const r = map.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    map.w = r.width; map.h = r.height; map.dpr = dpr;
    map.canvas.width = Math.round(r.width * dpr); map.canvas.height = Math.round(r.height * dpr);
    const pad = Math.max(16, r.width * 0.05);
    const proj = d3.geoMercator().fitExtent([[pad, pad * 1.2], [r.width - pad, r.height - pad]],
      { type: "MultiPoint", coordinates: [[5.87, 47.27], [15.04, 55.06], [5.87, 55.06], [15.04, 47.27]] });
    const project = (lat, lon) => proj([lon / 1e4, lat / 1e4]);
    map.proj = proj;
    const P = D.P;
    map.x = new Float32Array(P.n); map.y = new Float32Array(P.n); map.rad = new Float32Array(P.n);
    map.r = Math.max(1.3, Math.min(2.6, r.width / 330));
    for (let i = 0; i < P.n; i++) {
      const p = project(P.lat[i], P.lon[i]); map.x[i] = p[0]; map.y[i] = p[1];
      map.rad[i] = map.r * Math.min(2.6, 0.75 + 0.22 * Math.sqrt(P.lp[i]));
    }
    const a = D.acDots, na = a.m.length;
    map.ax = new Float32Array(na); map.ay = new Float32Array(na);
    for (let i = 0; i < na; i++) { const p = project(a.lat[i], a.lon[i]); map.ax[i] = p[0]; map.ay[i] = p[1]; }
    map.tree = null;
  }

  function drawMap() {
    const { ctx, dpr, w, h } = map;
    if (!ctx || !w) return;
    const t = state.mapT;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COL.surface; ctx.fillRect(0, 0, w, h);

    // AC-Hintergrund
    const a = D.acDots, s = Math.max(1, map.r * 0.75);
    ctx.fillStyle = COL.ghost;
    for (let i = 0; i < a.m.length; i++) {
      if (a.m[i] > t) continue;
      ctx.globalAlpha = inBl(a.bl[i]) ? 1 : 0.35;
      ctx.fillRect(map.ax[i] - s / 2, map.ay[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    const cls = clsArr(), P = D.P;
    const counts = [0, 0, 0, 0];
    const fresh = [];
    for (let pass = 0; pass < 2; pass++) { // erst andere Länder blass, dann Auswahl
      for (let c = 0; c < 4; c++) {
        ctx.beginPath();
        for (let i = 0; i < P.n; i++) {
          if (P.m[i] > t) break;
          if (!state.kw[P.pc[i]] || cls[i] !== c) continue;
          const sel = inBl(P.bl[i]);
          if ((pass === 0) === sel) continue;
          if (sel) { counts[c] += 1; if (t - P.m[i] < 3) fresh.push(i); }
          const r = map.rad[i];
          ctx.moveTo(map.x[i] + r, map.y[i]);
          ctx.arc(map.x[i], map.y[i], r, 0, Math.PI * 2);
        }
        ctx.fillStyle = COL.cls[c];
        ctx.globalAlpha = pass === 0 ? 0.18 : 0.85;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    // Frisch eröffnete Parks mit Ring
    if (map.playing) {
      ctx.lineWidth = 1;
      for (const i of fresh) {
        const age = (t - P.m[i] + (map.phase || 0)) / 3;
        ctx.strokeStyle = COL.cls[cls[i]];
        ctx.globalAlpha = Math.max(0, 0.6 * (1 - age));
        ctx.beginPath(); ctx.arc(map.x[i], map.y[i], map.rad[i] * (1.4 + age * 3.5), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // Markierter Park (aus der Pampa-Liste) mit Radius bis zum nächsten älteren DC
    if (map.focus != null && P.m[map.focus] <= t) {
      const i = map.focus, d = distArr()[i];
      if (d > 0) {
        const kmPx = map.y[i] - map.proj([P.lon[i] / 1e4, P.lat[i] / 1e4 + 1 / 111.32])[1]; // Pixel je km in Nord-Süd-Richtung
        ctx.beginPath(); ctx.arc(map.x[i], map.y[i], (d / 1000) * kmPx, 0, Math.PI * 2);
        ctx.fillStyle = COL.cls[3]; ctx.globalAlpha = 0.1; ctx.fill();
        ctx.globalAlpha = 0.7; ctx.lineWidth = 1.5; ctx.strokeStyle = COL.ink; ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(map.x[i], map.y[i], map.r * 3, 0, Math.PI * 2);
      ctx.fillStyle = COL.ink; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = COL.surface; ctx.stroke();
    }
    if (map.hover != null) {
      const i = map.hover;
      ctx.beginPath(); ctx.arc(map.x[i], map.y[i], Math.max(map.r * 2.6, map.rad[i] + 2), 0, Math.PI * 2);
      ctx.fillStyle = COL.cls[cls[i]]; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = COL.surface; ctx.stroke();
    }

    $("#map-year").textContent = yearOfM(t);
    $("#map-t").value = t;
    $("#map-t-out").textContent = mLabel(t);
    const total = d3.sum(counts);
    $("#l-map").innerHTML = CLASS_NAMES.map((n, i) =>
      `<span class="legend-item"><span><i class="sw dot" style="background:${COL.cls[i]}"></i>${n}</span><span class="val">${total ? fmtPct(counts[i] / total) : "–"}</span></span>`).join("");
    $("#map-stats").innerHTML = `<strong>${fmtInt(total)}</strong>DC-Ladeparks bis ${mLabel(t)}${state.bl >= 0 ? `, ${D.bl[state.bl]}` : ""}. Anteile nach Abstand bei Eröffnung, Punktgröße nach Ladepunkten.`;
  }

  function parkTip(i) {
    const P = D.P, d = distArr()[i], c = clsArr()[i];
    return `<div class="tt-h">${D.ort[P.ort[i]]}</div>` + ttRow("Betreiber", shortOp(D.op[P.op[i]])) +
      ttRow("Eröffnet", mLabel(P.m[i])) + ttRow("Heute", `${P.lp[i]} LP · bis ${fmtInt(P.kw[i])} kW`) +
      ttRow("Abstand bei Eröffnung", d < 0 ? "erster Park" : fmtDist(d), COL.cls[c]) + ttRow("Klasse", CLASS_NAMES[c]);
  }

  function mapHover(ev) {
    const r = map.canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const P = D.P;
    if (!map.tree || map.treeT !== state.mapT || map.treeKey !== keyOf()) {
      const idx = [];
      for (let i = 0; i < P.n && P.m[i] <= state.mapT; i++) if (state.kw[P.pc[i]] && inBl(P.bl[i])) idx.push(i);
      map.tree = d3.quadtree(idx, (i) => map.x[i], (i) => map.y[i]);
      map.treeT = state.mapT; map.treeKey = keyOf();
    }
    const i = map.tree.find(mx, my, 14);
    if (i === undefined) { if (map.hover != null) { map.hover = null; drawMap(); } hideTip(); return; }
    if (map.hover !== i) { map.hover = i; drawMap(); }
    showTip(parkTip(i), ev);
  }
  const keyOf = () => `${state.bl}|${state.kw.join()}|${state.ref}`;

  function startPlay() {
    map.playing = true;
    $("#map-play").classList.add("is-playing");
    const startM = (state.from - D.base) * 12, endM = Math.min(D.lastM, (state.to - D.base) * 12 + 11);
    if (state.mapT >= endM || state.mapT < startM) state.mapT = startM;
    const msPerMonth = Math.max(60, Math.min(160, 14000 / Math.max(1, endM - startM)));
    let last = performance.now(), accum = 0;
    const step = (now) => {
      if (!map.playing) return;
      accum += now - last; last = now;
      map.phase = accum / msPerMonth;
      if (accum >= msPerMonth) { accum = 0; map.phase = 0; state.mapT += 1; }
      if (state.mapT >= endM) { state.mapT = endM; drawMap(); stopPlay(); return; }
      drawMap();
      map.raf = requestAnimationFrame(step);
    };
    map.raf = requestAnimationFrame(step);
  }
  function stopPlay() {
    map.playing = false;
    cancelAnimationFrame(map.raf);
    $("#map-play").classList.remove("is-playing");
    drawMap();
  }

  // --------------------------------------------------------------------------
  // 4 · Versorgungsdistanz je Jahresende
  // --------------------------------------------------------------------------
  const cCov = {};
  const COV_SERIES = [["Median", COL.dc, 0.5], ["90 % der Zellen", COL.ac, 0.9]];
  function initCov() {
    const f = cCov.f = frame("#c-cov", { t: 14, r: 72, b: 30, l: 52 });
    f.gGrid = f.g.append("g").attr("class", "gridline");
    f.gY = f.g.append("g").attr("class", "axis");
    f.gX = f.g.append("g").attr("class", "axis");
    f.base = f.g.append("line").attr("class", "baseline");
    f.lines = COV_SERIES.map(([, c]) => f.g.append("path").attr("fill", "none").attr("stroke", c).attr("stroke-width", 2).attr("stroke-linejoin", "round").attr("stroke-linecap", "round"));
    f.dots = COV_SERIES.map(([, c]) => f.g.append("circle").attr("r", 4.5).attr("fill", c).attr("stroke", COL.surface).attr("stroke-width", 2));
    f.lbls = COV_SERIES.map(() => f.g.append("text").attr("class", "lbl-strong").attr("dy", "0.35em"));
    f.hLine = f.g.append("line").attr("class", "hover-line").style("opacity", 0);
    f.overlay = f.g.append("rect").attr("fill", "transparent");
    legend("#l-cov", COV_SERIES.map(([n, c]) => [n, c]), "line");
  }

  function covData() {
    const c = D.cov, arr = state.ref === "da" ? c.da : c.dh;
    const cells = [];
    for (let k = 0; k < c.bl.length; k++) if (inBl(c.bl[k])) cells.push(k);
    return c.years.map((y, yi) => {
      const v = [];
      for (const k of cells) { const d = arr[yi][k]; if (d >= 0) v.push(d / 10); }
      v.sort(d3.ascending);
      return { y, n: v.length, q: COV_SERIES.map(([, , q]) => (v.length ? d3.quantileSorted(v, q) : NaN)) };
    });
  }

  function renderCov(animate) {
    const f = cCov.f.measure();
    const t = tr(animate);
    const all = covData();
    const x = d3.scaleLinear().domain([state.from, Math.max(state.to, state.from + 1)]).range([0, f.w]);
    const vis = all.filter((d) => d.y >= state.from && d.y <= state.to);
    const vals = vis.flatMap((d) => d.q.filter((v) => isFinite(v) && v > 0));
    const ymax = d3.max(vals) || 10, ymin = d3.min(vals) || 1;
    const y = d3.scaleLog().domain([Math.min(1, ymin * 0.8), Math.max(10, ymax * 1.15)]).range([f.h, 0]);
    const ticks = [0.5, 1, 2, 5, 10, 20, 50, 100, 200].filter((v) => v >= y.domain()[0] && v <= y.domain()[1]);
    const g = f.gGrid.selectAll("line").data(ticks, (d) => d).join((e) => e.append("line").attr("y1", (d) => y(d)).attr("y2", (d) => y(d)));
    g.attr("x1", 0).attr("x2", f.w);
    (t ? g.transition(t) : g).attr("y1", (d) => Math.round(y(d)) + 0.5).attr("y2", (d) => Math.round(y(d)) + 0.5);
    const yl = f.gY.selectAll("text").data(ticks, (d) => d).join((e) => e.append("text").attr("x", -10).attr("dy", "0.35em").attr("text-anchor", "end").attr("y", (d) => y(d)));
    yl.text((d) => `${locale.format(",")(d)} km`);
    (t ? yl.transition(t) : yl).attr("y", (d) => y(d));
    f.base.attr("x1", 0).attr("x2", f.w).attr("y1", f.h + 0.5).attr("y2", f.h + 0.5);

    const years = vis.map((d) => d.y);
    const every = Math.ceil(years.length / Math.max(2, Math.floor(f.w / 56)));
    f.gX.attr("transform", `translate(0,${f.h + 20})`).selectAll("text").data(years.filter((_, i) => i % every === 0), (d) => d)
      .join((e) => e.append("text").attr("text-anchor", "middle").attr("x", (d) => x(d)).style("opacity", 0), (u) => u, (ex) => ex.remove())
      .text((d) => (d === D.lastYear ? `${d}*` : d))
      .transition(t).attr("x", (d) => x(d)).style("opacity", 1);

    COV_SERIES.forEach((_, si) => {
      const pts = all.map((d) => (d.y >= state.from && d.y <= state.to ? [x(d.y), isFinite(d.q[si]) ? y(d.q[si]) : NaN] : [x(d.y), NaN]));
      tweenPath(f.lines[si], pts, d3.line().defined((p) => isFinite(p[1])).curve(d3.curveMonotoneX), t);
      const last = [...vis].reverse().find((d) => isFinite(d.q[si]));
      if (last) {
        const ex = x(last.y), ey = y(last.q[si]);
        (t ? f.dots[si].transition(t) : f.dots[si]).attr("cx", ex).attr("cy", ey).style("opacity", 1);
        f.lbls[si].text(`${fmt1(last.q[si])} km`);
        (t ? f.lbls[si].transition(t) : f.lbls[si]).attr("x", ex + 10).attr("y", ey).style("opacity", 1);
      } else { f.dots[si].style("opacity", 0); f.lbls[si].style("opacity", 0); }
    });

    f.overlay.attr("width", f.w).attr("height", f.h).on("pointermove", (ev) => {
      const yv = Math.round(x.invert(d3.pointer(ev)[0]));
      const d = vis.find((e) => e.y === yv);
      if (!d) { hideTip(); return; }
      f.hLine.attr("x1", x(yv)).attr("x2", x(yv)).attr("y1", 0).attr("y2", f.h).style("opacity", 1);
      showTip(`<div class="tt-h">${yv === D.lastYear ? `Stand ${D.raw.meta.stand}` : `Ende ${yv}`}</div>` +
        COV_SERIES.map(([n, c], i) => ttRow(i === 0 ? "Hälfte der Zellen näher als" : "90 % der Zellen näher als", `${fmt1(d.q[i])} km`, c)).join("") +
        ttRow("Rasterzellen", fmtInt(d.n)), ev);
    }).on("pointerleave", () => { hideTip(); f.hLine.style("opacity", 0); });
  }

  // --------------------------------------------------------------------------
  // 5 · Zubau je Quartal (AC/DC gestapelt, mit Brush)
  // --------------------------------------------------------------------------
  const cZubau = {};
  function initZubau() {
    const f = cZubau.f = frame("#c-zubau", { t: 14, r: 8, b: 30, l: 52 });
    f.gGrid = f.g.append("g").attr("class", "gridline");
    f.gY = f.g.append("g").attr("class", "axis");
    f.gBars = f.g.append("g");
    f.gX = f.g.append("g").attr("class", "axis");
    f.gBrush = f.g.append("g").attr("class", "brush");
    legend("#l-zubau", [["DC", COL.dc], ["AC", COL.ac]]);
  }

  function zubauData() {
    const q0 = (state.from - D.base) * 4, q1 = Math.min(Math.floor(D.lastM / 3), (state.to - D.base) * 4 + 3);
    const rows = new Map(d3.range(q0, q1 + 1).map((q) => [q, { q, dc: 0, ac: 0 }]));
    for (const i of selDC()) { const r = rows.get(Math.floor(D.dc.m[i] / 3)); if (r) r.dc += D.dc.lp[i]; }
    for (const [m, b, , lp] of D.ac) { if (!inBl(b)) continue; const r = rows.get(Math.floor(m / 3)); if (r) r.ac += lp; }
    return [...rows.values()];
  }

  function renderZubau(animate) {
    const f = cZubau.f.measure();
    const t = tr(animate);
    const data = zubauData();
    const x = d3.scaleBand().domain(data.map((d) => d.q)).range([0, f.w]).paddingInner(data.length > 40 ? 0.12 : 0.24);
    const bw = Math.min(24, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.dc + d.ac) || 1]).nice(4).range([f.h, 0]);
    const ticks = y.ticks(4);
    const gl = f.gGrid.selectAll("line").data(ticks.slice(1), (d) => d).join((e) => e.append("line").attr("y1", (d) => y(d)).attr("y2", (d) => y(d)));
    gl.attr("x1", 0).attr("x2", f.w);
    (t ? gl.transition(t) : gl).attr("y1", (d) => Math.round(y(d)) + 0.5).attr("y2", (d) => Math.round(y(d)) + 0.5);
    const yl = f.gY.selectAll("text").data(ticks, (d) => d).join((e) => e.append("text").attr("x", -10).attr("dy", "0.35em").attr("text-anchor", "end").attr("y", (d) => y(d)));
    yl.text((d) => fmtInt(d));
    (t ? yl.transition(t) : yl).attr("y", (d) => y(d));

    const years = [...new Set(data.map((d) => Math.floor(d.q / 4)))];
    const every = Math.ceil(years.length / Math.max(2, Math.floor(f.w / 52)));
    f.gX.attr("transform", `translate(0,${f.h + 20})`).selectAll("text").data(years.filter((_, i) => i % every === 0), (d) => d)
      .join((e) => e.append("text").attr("text-anchor", "start").style("opacity", 0).attr("x", (d) => x(d * 4) ?? 0), (u) => u, (ex) => ex.remove())
      .text((d) => D.base + d).transition(t).attr("x", (d) => (x(d * 4) ?? x(data[0].q)) + off).style("opacity", 1);

    const GAP = 2;
    const cols = f.gBars.selectAll("g.col").data(data, (d) => d.q).join(
      (e) => {
        const g = e.append("g").attr("class", "col").attr("transform", (d) => `translate(${x(d.q) + off},0)`);
        g.append("path").attr("class", "dc").attr("fill", COL.dc).attr("d", `M0,${f.h}h${bw}v0h${-bw}Z`);
        g.append("path").attr("class", "ac").attr("fill", COL.ac).attr("d", `M0,${f.h}h${bw}v0h${-bw}Z`);
        g.append("rect").attr("class", "hit").attr("fill", "transparent");
        return g;
      },
      (u) => u, (ex) => (t ? ex.transition(t).style("opacity", 0).remove() : ex.remove())
    );
    (t ? cols.transition(t) : cols).attr("transform", (d) => `translate(${x(d.q) + off},0)`).style("opacity", 1);
    cols.each(function (d) {
      const g = d3.select(this);
      const yDc = y(d.dc), yTop = y(d.dc + d.ac);
      const hDc = f.h - yDc, hAc = Math.max(0, yDc - yTop - (d.dc > 0 ? GAP : 0));
      const pDc = d.ac > 0 ? `M0,${yDc}h${bw}v${hDc}h${-bw}Z` : roundedTop(0, yDc, bw, hDc, Math.min(4, bw / 3));
      const pAc = roundedTop(0, yTop, bw, hAc, Math.min(4, bw / 3));
      const a = g.select("path.dc"), b = g.select("path.ac");
      (t ? a.transition(t) : a).attr("d", pDc);
      (t ? b.transition(t) : b).attr("d", pAc);
      g.select("rect.hit").attr("x", -off).attr("width", x.bandwidth()).attr("y", 0).attr("height", f.h);
    });
    cols.on("pointermove", (ev, d) => {
      showTip(`<div class="tt-h">${qLabel(d.q)}</div>` + ttRow("DC", fmtInt(d.dc), COL.dc) + ttRow("AC", fmtInt(d.ac), COL.ac) +
        ttRow("DC-Anteil", d.dc + d.ac ? fmtPct(d.dc / (d.dc + d.ac)) : "–"), ev);
      cols.style("opacity", (e) => (e === d ? 1 : 0.6));
    }).on("pointerleave", () => { hideTip(); cols.style("opacity", 1); });

    // Brush: Zeitraum aufziehen
    const brush = d3.brushX().extent([[0, 0], [f.w, f.h]]).on("end", (ev) => {
      if (!ev.selection || !ev.sourceEvent) return;
      const [a, b] = ev.selection;
      const qs = data.filter((d) => x(d.q) + x.bandwidth() > a && x(d.q) < b).map((d) => d.q);
      f.gBrush.call(brush.move, null);
      if (!qs.length) return;
      state.from = D.base + Math.floor(qs[0] / 4);
      state.to = D.base + Math.floor(qs[qs.length - 1] / 4);
      syncFilters(); update(true);
    });
    f.gBrush.call(brush);
    f.gBrush.selectAll(".selection").attr("fill", COL.ink).attr("fill-opacity", 0.06).attr("stroke", "none");
    f.gBrush.select(".overlay").style("cursor", "col-resize");
    // Hover der Säulen soll trotz Brush-Overlay funktionieren
    f.gBrush.select(".overlay").on("pointermove.tt", (ev) => {
      const [mx] = d3.pointer(ev);
      const d = data.find((e) => mx >= x(e.q) && mx < x(e.q) + x.bandwidth() + x.step() * x.paddingInner());
      if (!d) { hideTip(); return; }
      showTip(`<div class="tt-h">${qLabel(d.q)}</div>` + ttRow("DC", fmtInt(d.dc), COL.dc) + ttRow("AC", fmtInt(d.ac), COL.ac) +
        ttRow("DC-Anteil", d.dc + d.ac ? fmtPct(d.dc / (d.dc + d.ac)) : "–"), ev);
      cols.style("opacity", (e) => (e === d ? 1 : 0.6));
    }).on("pointerleave.tt", () => { hideTip(); cols.style("opacity", 1); });
  }

  // --------------------------------------------------------------------------
  // 6 · Leistungsverteilung
  // --------------------------------------------------------------------------
  const cKw = {};
  const KW_BINS = [[0, 50, "< 50"], [50, 100, "50"], [100, 150, "100"], [150, 200, "150"], [200, 250, "200"], [250, 300, "250"], [300, 350, "300"], [350, 400, "350"], [400, 1e9, "400+"]];
  function initKw() {
    const f = cKw.f = frame("#c-kw", { t: 22, r: 4, b: 30, l: 4 });
    f.gBars = f.g.append("g");
    f.gX = f.g.append("g").attr("class", "axis");
    f.base = f.g.append("line").attr("class", "baseline");
  }
  function renderKw(animate) {
    const f = cKw.f.measure();
    const t = tr(animate);
    const v = KW_BINS.map(() => 0);
    for (let i = 0; i < D.n; i++) {
      if (!inBl(D.dc.bl[i]) || D.yr[i] < state.from || D.yr[i] > state.to) continue;
      const k = KW_BINS.findIndex(([a, b]) => D.dc.kw[i] >= a && D.dc.kw[i] < b);
      v[k] += D.dc.lp[i];
    }
    const data = KW_BINS.map(([a, , l], k) => ({ k, l, v: v[k], pc: pwOf(a) }));
    const x = d3.scaleBand().domain(data.map((d) => d.k)).range([0, f.w]).paddingInner(0.3).paddingOuter(0.1);
    const bw = Math.min(40, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) || 1]).range([f.h, 0]);
    const total = d3.sum(v);
    f.base.attr("x1", 0).attr("x2", f.w).attr("y1", f.h + 0.5).attr("y2", f.h + 0.5);
    f.gX.attr("transform", `translate(0,${f.h + 20})`).selectAll("text").data(data).join("text").attr("text-anchor", "middle")
      .attr("x", (d) => x(d.k) + x.bandwidth() / 2).text((d) => d.l);
    const g = f.gBars.selectAll("g").data(data).join((e) => {
      const gg = e.append("g");
      gg.append("path").attr("d", (d) => `M${x(d.k) + off},${f.h}h${bw}v0h${-bw}Z`);
      gg.append("text").attr("class", "lbl").attr("text-anchor", "middle").attr("y", f.h - 6);
      return gg;
    });
    g.select("path").attr("fill", (d) => COL.pw[d.pc]);
    (t ? g.select("path").transition(t) : g.select("path")).attr("d", (d) => roundedTop(x(d.k) + off, y(d.v), bw, f.h - y(d.v), 4))
      .style("opacity", (d) => (state.kw[d.pc] ? 1 : 0.25));
    const lbl = g.select("text");
    lbl.text((d) => (total ? fmtPct(d.v / total) : ""));
    (t ? lbl.transition(t) : lbl).attr("x", (d) => x(d.k) + x.bandwidth() / 2).attr("y", (d) => y(d.v) - 7).style("opacity", (d) => (state.kw[d.pc] ? 1 : 0.4));
    g.on("pointermove", (ev, d) => showTip(`<div class="tt-h">${d.l === "< 50" ? "unter 50" : d.l === "400+" ? "ab 400" : `${d.l} – ${+d.l + 49}`} kW</div>` +
      ttRow("DC-Ladepunkte", fmtInt(d.v), COL.pw[d.pc]) + ttRow("Anteil", total ? fmtPct(d.v / total) : "–") + ttRow("Klasse", PW_NAMES[d.pc]), ev))
      .on("pointerleave", hideTip);
  }

  // --------------------------------------------------------------------------
  // 7 · Betreiber & 8 · Bundesländer (HTML-Balken mit Umsortier-Animation)
  // --------------------------------------------------------------------------
  const ROW_H = 34;
  function hbars(el, rows, opts) {
    const box = d3.select(el).style("position", "relative").style("height", `${rows.length * ROW_H}px`)
      .style("transition", reduceMotion ? null : "height .6s ease");
    const max = d3.max(rows, (r) => d3.sum(r.parts)) || 1;
    const sel = box.selectAll("div.hbar-row").data(rows, (r) => r.key).join(
      (e) => {
        const r = e.append("div").attr("class", "hbar-row").style("position", "absolute").style("left", 0).style("right", 0)
          .style("transform", (_, i) => `translateY(${i * ROW_H}px)`).style("opacity", 0);
        r.append("div").attr("class", "hbar-name");
        const area = r.append("div").attr("class", "hbar-area").style("min-width", 0);
        const track = area.append("div").style("display", "flex").style("align-items", "center").style("gap", "10px");
        track.append("div").attr("class", "hbar-bar").style("display", "flex").style("gap", "2px").style("height", "12px").style("flex", "none");
        track.append("span").attr("class", "lbl-html").style("font-size", "12px").style("color", "var(--ink-2)").style("white-space", "nowrap").style("font-variant-numeric", "tabular-nums");
        return r;
      },
      (u) => u,
      (ex) => ex.style("opacity", 0).transition().duration(400).remove()
    );
    sel.style("transition", reduceMotion ? null : "transform .7s cubic-bezier(.65,0,.35,1), opacity .5s ease")
      .classed("clickable", !!opts.onClick)
      .classed("is-active", (r) => !!r.active)
      .style("transform", (_, i) => `translateY(${i * ROW_H}px)`).style("opacity", 1);
    sel.select(".hbar-name").text((r) => r.name).attr("title", (r) => r.title || r.name);
    sel.select(".lbl-html").text((r) => opts.label(r));
    sel.select(".hbar-area").style("padding-right", `${opts.labelSpace}px`);
    sel.each(function (r) {
      const bar = d3.select(this).select(".hbar-bar");
      const total = d3.sum(r.parts);
      bar.style("width", `${(total / max) * 100}%`)
        .style("transition", reduceMotion ? null : "width .7s cubic-bezier(.65,0,.35,1)");
      bar.selectAll("i").data(r.parts).join((e) => e.append("i").style("display", "block").style("height", "100%").style("flex", "0 0 0%"))
        .style("background", (_, k) => opts.colors[k])
        .style("border-radius", (_, k) => (k === r.parts.length - 1 || r.parts.slice(k + 1).every((p) => !p) ? "0 4px 4px 0" : "0"))
        .style("transition", reduceMotion ? null : "flex-basis .7s cubic-bezier(.65,0,.35,1)")
        .style("flex-basis", (p) => `${total ? (p / total) * 100 : 0}%`)
        .style("min-width", (p) => (p > 0 ? "2px" : "0"));
    });
    sel.on("click", opts.onClick ? (_, r) => opts.onClick(r) : null)
      .on("pointermove", opts.tip ? (ev, r) => showTip(opts.tip(r), ev) : null)
      .on("pointerleave", hideTip);
  }

  function renderOp() {
    const sums = new Map();
    for (const i of selDC()) {
      if (D.yr[i] < state.from || D.yr[i] > state.to) continue;
      sums.set(D.dc.op[i], (sums.get(D.dc.op[i]) || 0) + D.dc.lp[i]);
    }
    const total = d3.sum(sums.values());
    const top = [...sums].sort((a, b) => b[1] - a[1]).slice(0, 10);
    hbars($("#c-op"), top.map(([op, v]) => ({ key: op, name: shortOp(D.op[op]), title: D.op[op], parts: [v], v })), {
      colors: [COL.dc], labelSpace: 90,
      label: (r) => `${fmtInt(r.v)} · ${fmtPct(r.v / total)}`,
      tip: (r) => `<div class="tt-h">${r.title}</div>` + ttRow("DC-Ladepunkte", fmtInt(r.v), COL.dc) + ttRow("Marktanteil im Filter", fmtPct(r.v / total)),
    });
  }

  function renderBl() {
    const rows = D.bl.map((name, b) => ({ key: b, name, dc: 0, ac: 0 }));
    for (let i = 0; i < D.n; i++) {
      if (D.yr[i] < state.from || D.yr[i] > state.to || !state.kw[D.pc[i]]) continue;
      rows[D.dc.bl[i]].dc += D.dc.lp[i];
    }
    for (const [m, b, , lp] of D.ac) { const y = yearOfM(m); if (y >= state.from && y <= state.to) rows[b].ac += lp; }
    rows.forEach((r) => { r.parts = [r.dc, r.ac]; r.active = r.key === state.bl; });
    rows.sort((a, b) => b.dc + b.ac - (a.dc + a.ac));
    hbars($("#c-bl"), rows, {
      colors: [COL.dc, COL.ac], labelSpace: 120,
      label: (r) => `${fmtInt(r.dc + r.ac)} · ${r.dc + r.ac ? fmtPct(r.dc / (r.dc + r.ac)) : "–"} DC`,
      onClick: (r) => { state.bl = state.bl === r.key ? -1 : r.key; syncFilters(); update(true); },
      tip: (r) => `<div class="tt-h">${r.name}</div>` + ttRow("DC", fmtInt(r.dc), COL.dc) + ttRow("AC", fmtInt(r.ac), COL.ac) +
        ttRow("DC-Anteil", r.dc + r.ac ? fmtPct(r.dc / (r.dc + r.ac)) : "–"),
    });
    legend("#l-bl", [["DC", COL.dc], ["AC", COL.ac]]);
  }

  // --------------------------------------------------------------------------
  // KPIs
  // --------------------------------------------------------------------------
  function renderKpis(animate) {
    let acLp = 0, acNew = 0;
    for (const [m, b, , lp] of D.ac) {
      if (!inBl(b)) continue;
      const y = yearOfM(m);
      if (y <= state.to) acLp += lp;
      if (y >= state.from && y <= state.to) acNew += lp;
    }
    let dcLp = 0, dcKw = 0, dcNew = 0;
    for (const i of selDC()) {
      if (D.yr[i] > state.to) continue;
      dcLp += D.dc.lp[i]; dcKw += D.dc.kw[i];
      if (D.yr[i] >= state.from) dcNew += D.dc.lp[i];
    }
    const vals = [], wts = [];
    const dist = distArr(), cls = clsArr();
    let newArea = 0, newTot = 0;
    for (const i of selPark()) {
      if (D.P.yr[i] < state.from || D.P.yr[i] > state.to) continue;
      newTot += 1;
      if (cls[i] === 3) newArea += 1;
      if (dist[i] >= 0) { vals.push(dist[i]); wts.push(1); }
    }
    const allKw = state.kw.every(Boolean);
    const upto = state.to >= D.lastYear ? `Stand ${D.raw.meta.stand}` : `Ende ${state.to}`;
    const place = state.bl >= 0 ? D.bl[state.bl] : "Deutschland";
    tweenNumber("#k-lp", acLp + dcLp, fmtCompact, animate);
    $("#k-lp-note").textContent = `${place}, ${upto}. Zubau ${state.from === state.to ? state.from : `${state.from}–${state.to}`}: +${fmtInt(acNew + dcNew)}`;
    tweenNumber("#k-dc", dcLp, fmtInt, animate);
    $("#k-dc-note").textContent = `${fmtPct(dcLp / (acLp + dcLp || 1))} aller Ladepunkte${allKw ? "" : " · Leistungsfilter aktiv"}`;
    tweenNumber("#k-kw", dcKw / 1e6, (v) => `${locale.format(",.2f")(v)} GW`, animate);
    $("#k-kw-note").textContent = `Summe Nennleistung DC-Ladeeinrichtungen`;
    const med = vals.length ? wQuantiles(vals, wts, [0.5])[0] : NaN;
    tweenNumber("#k-med", med, fmtDist, animate);
    $("#k-med-note").textContent = newTot ? `${fmtInt(newTot)} neue Parks, ${fmtPct(newArea / newTot)} davon auf neuer Fläche` : "keine neuen Ladeparks im Filter";
  }

  // --------------------------------------------------------------------------
  // Betreiber-Ranking: Fläche oder Bestand?
  // --------------------------------------------------------------------------
  const MIN_PARKS = 5;
  const RANK_MONTHS = 12;
  function renderOpRank() {
    const cls = clsArr(), dist = distArr();
    const rows = new Map(D.topOps.map((op) => [op, { c: [0, 0, 0, 0], d: [] }]));
    const m0 = D.lastM - RANK_MONTHS + 1;
    for (const i of selPark()) {
      const r = rows.get(D.P.op[i]);
      if (!r || D.P.m[i] < m0) continue;
      r.c[cls[i]] += 1;
      if (dist[i] >= 0) r.d.push(dist[i]);
    }
    const out = [];
    let hidden = 0;
    for (const [op, r] of rows) {
      const n = d3.sum(r.c);
      if (n < MIN_PARKS) { hidden++; continue; }
      const far = (r.c[2] + r.c[3]) / n;
      out.push({ key: op, name: shortOp(D.op[op]), title: D.op[op], n, c: r.c, far,
        med: r.d.length ? d3.median(r.d) : NaN, parts: [r.c[3] / n, r.c[2] / n, r.c[1] / n, r.c[0] / n] });
    }
    out.sort((a, b) => b.far - a.far || b.med - a.med);
    hbars($("#c-oprank"), out, {
      colors: [COL.cls[3], COL.cls[2], COL.cls[1], COL.cls[0]], labelSpace: 118,
      label: (r) => `${fmtPct(r.far)} · ${fmtDist(r.med)}`,
      tip: (r) => `<div class="tt-h">${r.title}</div>` +
        d3.range(3, -1, -1).map((k) => ttRow(CLASS_NAMES[k], `${fmtPct(r.c[k] / r.n)} · ${fmtInt(r.c[k])}`, COL.cls[k])).join("") +
        ttRow("Median-Abstand", fmtDist(r.med)) + ttRow("Neue Ladeparks", fmtInt(r.n)),
    });
    $("#oprank-note").textContent = `Neue Parks ${mLabel(m0)} bis ${mLabel(D.lastM)}, unabhängig vom Zeitraumfilter.` +
      (hidden ? ` ${hidden} der 15 größten Betreiber mit weniger als ${MIN_PARKS} neuen Parks ausgeblendet.` : "");
  }

  // --------------------------------------------------------------------------
  // Pampa: alle Parks der letzten drei Monate mit Abstand >= Schwelle
  // --------------------------------------------------------------------------
  function renderPampa() {
    const PAMPA_ROW = innerWidth < 720 ? 78 : 64;
    const P = D.P, dist = distArr();
    const m0 = D.lastM - PAMPA_MONTHS + 1, minD = state.pampaKm * 1000;
    const top = [];
    for (let i = 0; i < P.n; i++) {
      if (P.m[i] < m0 || dist[i] < minD || !inBl(P.bl[i]) || !state.kw[P.pc[i]]) continue;
      top.push(i);
    }
    top.sort((a, b) => dist[b] - dist[a]);
    $("#pampa-km-out").textContent = `ab ${state.pampaKm} km`;
    $("#pampa-count").textContent = `${top.length} ${top.length === 1 ? "Ladepark" : "Ladeparks"} · eröffnet ${mLabel(m0)} bis ${mLabel(D.lastM)}`;
    if (map.focus != null && !top.includes(map.focus)) map.focus = null;
    const max = top.length ? Math.max(dist[top[0]], 20000) : 1;
    const box = d3.select("#c-pampa").style("height", `${Math.max(1, top.length) * PAMPA_ROW}px`);
    const rows = box.selectAll("button.pampa-row").data(top, (i) => i).join(
      (e) => {
        const r = e.append("button").attr("type", "button").attr("class", "pampa-row")
          .style("transform", (_, k) => `translateY(${k * PAMPA_ROW}px)`).style("opacity", 0);
        r.append("span").attr("class", "pampa-rank");
        const t = r.append("span").attr("class", "pampa-text");
        t.append("span").attr("class", "pampa-ort");
        t.append("span").attr("class", "pampa-sub");
        const v = r.append("span").attr("class", "pampa-val");
        v.append("span").attr("class", "pampa-dist");
        v.append("span").attr("class", "pampa-bar").append("i");
        return r;
      },
      (u) => u,
      (ex) => ex.style("opacity", 0).transition().duration(400).remove()
    );
    rows.style("transform", (_, k) => `translateY(${k * PAMPA_ROW}px)`).style("opacity", 1)
      .classed("is-active", (i) => i === map.focus);
    rows.select(".pampa-rank").text((_, k) => String(k + 1).padStart(2, "0"));
    rows.select(".pampa-ort").text((i) => `${D.ort[P.ort[i]]}`);
    rows.select(".pampa-sub").text((i) => `${shortOp(D.op[P.op[i]])} · ${mLabel(P.m[i])} · ${P.lp[i]} LP · ${fmtInt(P.kw[i])} kW`);
    rows.select(".pampa-dist").text((i) => fmtDist(dist[i]));
    rows.select(".pampa-bar i").style("width", (i) => `${(dist[i] / max) * 100}%`);
    rows.on("click", (_, i) => {
      map.focus = map.focus === i ? null : i;
      stopPlay();
      state.mapT = D.lastM;
      renderPampa(); drawMap();
      if (map.focus != null) document.querySelector(".block-map").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }).on("pointermove", (ev, i) => showTip(parkTip(i), ev)).on("pointerleave", hideTip);
    $("#pampa-empty").style.display = top.length ? "none" : "block";
    $("#pampa-empty").textContent = `Kein Ladepark im Zeitraum mit mindestens ${state.pampaKm} km Abstand. Regler nach links schieben.`;
  }

  // --------------------------------------------------------------------------
  function update(animate) {
    renderKpis(animate);
    renderDist(animate);
    renderClass(animate);
    renderCov(animate);
    renderZubau(animate);
    renderKw(animate);
    renderOp();
    renderBl();
    renderOpRank();
    renderPampa();
    if (!map.playing) {
      const endM = Math.min(D.lastM, (state.to - D.base) * 12 + 11);
      state.mapT = endM;
      $("#map-t").max = D.lastM;
    }
    map.tree = null;
    drawMap();
  }

  function onResize() {
    layoutMap();
    update(false);
  }

  async function boot() {
    const res = await fetch("data/lsr.json");
    const raw = await res.json();
    D = prepare(raw);
    DEFAULT_FROM = state.from = 2015;
    state.to = D.lastYear;
    $("#stand").textContent = `Stand ${raw.meta.stand}`;
    $("#src-stand").textContent = `Stand ${raw.meta.stand}, Lizenz ${raw.meta.license}`;

    setupFilters(); syncFilters();
    initDist(); initClass(); initMap(); initCov(); initZubau(); initKw();
    const pk = $("#pampa-km");
    pk.value = state.pampaKm;
    pk.addEventListener("input", () => { state.pampaKm = +pk.value; renderPampa(); });
    legend("#l-oprank", d3.range(3, -1, -1).map((i) => [CLASS_NAMES[i], COL.cls[i], CLASS_RANGES[i]]));
    layoutMap();
    update(false);
    $("#loading").classList.add("done");

    let rt;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(onResize, 120); }).observe(document.querySelector("main"));
  }

  boot().catch((err) => {
    console.error(err);
    $("#loading").innerHTML = "Daten konnten nicht geladen werden.";
  });
})();
