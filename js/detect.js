/*!
 * 3DmetaFix smart detect — infers a video's projection and stereo layout from
 * its pixels, so users don't have to know what "VR180 side-by-side" means.
 *
 * Each sampled frame is reduced to a small band-passed luminance image and scored
 * against every supported layout with four independent cues:
 *
 *   1. Stereo match   — normalised cross-correlation between the two halves
 *                       (left/right and top/bottom), searched over a small
 *                       disparity window. Stereo pairs correlate; mono halves don't.
 *   2. Eye aspect     — a 360° equirect eye is 2:1, a 180° eye is 1:1.
 *   3. Seam wrap      — in a full 360° panorama the left and right edges are
 *                       neighbours on the sphere, so they join seamlessly.
 *   4. Pole stretch   — equirect rows near the poles are smeared horizontally,
 *                       which flat camera footage never shows.
 *
 * Scores are combined in a softmax, giving a calibrated-ish confidence and a
 * human-readable list of reasons. Also flags circular-fisheye footage.
 *
 * Pure functions on RGBA pixel arrays: browser (window.MetaDetect) or Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MetaDetect = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const ANALYSIS_PIXELS = 320 * 160;
  const ANALYSIS_WIDTH = 320; // canvas width callers should draw frames at (2:1 reference)
  const STEREO_T = 0.45;              // correlation above which halves count as a stereo pair
  const W = { stereo: 6, aspect: 4, seam: 3, pole: 3 };
  // Mild priors: how common each layout is in practice.
  const PRIOR = { "360-sbs": -0.4, "180-tb": -0.5, "flat-sbs": -0.3, "flat-tb": -0.6 };
  const FLAT_ASPECTS = [16 / 9, 4 / 3, 1.85, 2.39, 9 / 16, 3 / 4, 1];

  const HYPOTHESES = [
    { key: "360-mono", fov: 360, stereo: "mono" }, { key: "360-tb", fov: 360, stereo: "tb" },
    { key: "360-sbs", fov: 360, stereo: "sbs" }, { key: "180-sbs", fov: 180, stereo: "sbs" },
    { key: "180-tb", fov: 180, stereo: "tb" }, { key: "180-mono", fov: 180, stereo: "mono" },
    { key: "flat-mono", fov: "flat", stereo: "mono" }, { key: "flat-sbs", fov: "flat", stereo: "sbs" },
    { key: "flat-tb", fov: "flat", stereo: "tb" }
  ];

  /**
   * Box-downsample RGBA to luminance with a fixed pixel budget (≈ 320×160) whatever the
   * aspect ratio, so every layout gets the same amount of noise averaging.
   */
  function toLuma(frame) {
    const { data, width, height } = frame;
    const tw = Math.min(width, Math.round(Math.sqrt((ANALYSIS_PIXELS * width) / height)));
    const th = Math.max(2, Math.round((height * tw) / width));
    const out = new Float32Array(tw * th);
    const cnt = new Float32Array(tw * th);
    const sx = tw / width, sy = th / height;
    for (let y = 0; y < height; y++) {
      const ty = Math.min(th - 1, (y * sy) | 0);
      let i = y * width * 4;
      for (let x = 0; x < width; x++, i += 4) {
        const t = ty * tw + Math.min(tw - 1, (x * sx) | 0);
        out[t] += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        cnt[t]++;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] /= cnt[i] || 1;
    return { L: out, w: tw, h: th };
  }

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  /** Best normalised cross-correlation between two equal-size regions over a shift window. */
  function bestNcc(D, w, ax, ay, bx, by, ew, eh, maxDx, maxDy) {
    let best = -1, bdx = 0;
    for (let dy = -maxDy; dy <= maxDy; dy++) {
      for (let dx = -maxDx; dx <= maxDx; dx++) {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
        for (let y = maxDy; y < eh - maxDy; y++) {
          const ra = (ay + y) * w + ax, rb = (by + y + dy) * w + bx + dx;
          for (let x = maxDx; x < ew - maxDx; x++) {
            const a = D[ra + x], b = D[rb + x];
            sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
          }
        }
        if (!n) continue;
        const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
        const r = va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : 0;
        if (r > best) { best = r; bdx = dx; }
      }
    }
    return { r: Math.max(0, best), dx: bdx };
  }

  function colDiff(L, w, x0, y0, eh, xa, xb) {
    let s = 0;
    for (let y = 0; y < eh; y++) s += Math.abs(L[(y0 + y) * w + x0 + xa] - L[(y0 + y) * w + x0 + xb]);
    return s / eh;
  }

  /** ≈1 when the region's left/right edges join like neighbouring columns (360° wrap), ≈0 when unrelated. */
  function seamScore(L, w, x0, y0, ew, eh) {
    const seam = (colDiff(L, w, x0, y0, eh, 0, ew - 1) + colDiff(L, w, x0, y0, eh, 1, ew - 2) / 2) / 1.5;
    const adj = [], far = [];
    const step = Math.max(1, Math.floor(ew / 24));
    for (let x = 1; x < ew - 2; x += step) {
      adj.push(colDiff(L, w, x0, y0, eh, x, x + 1));
      far.push(colDiff(L, w, x0, y0, eh, x, (x + (ew >> 1)) % ew));
    }
    adj.sort((a, b) => a - b);
    const a = adj[adj.length >> 1], f = far.reduce((s, v) => s + v, 0) / far.length;
    if (f - a < 1e-4) return 0.5;
    return Math.max(0, Math.min(1.2, (f - seam) / (f - a)));
  }

  /** Horizontal detail in the top/bottom rows relative to the middle: small ⇒ equirect poles. */
  function poleRatio(L, w, x0, y0, ew, eh) {
    const rowE = (y) => {
      let s = 0;
      for (let x = 0; x < ew - 2; x++) s += Math.abs(L[(y0 + y) * w + x0 + x + 2] - L[(y0 + y) * w + x0 + x]);
      return s / (ew - 2);
    };
    const band = Math.max(1, Math.round(eh * 0.035));
    let top = 0, bot = 0, mid = 0, nm = 0;
    for (let y = 0; y < band; y++) { top += rowE(y); bot += rowE(eh - 1 - y); }
    for (let y = Math.round(eh * 0.35); y < Math.round(eh * 0.65); y++) { mid += rowE(y); nm++; }
    mid /= nm || 1;
    if (mid < 1e-4) return 1;
    return Math.max(top, bot) / band / mid;
  }

  function regionStats(L, w, x0, y0, rw, rh) {
    let s = 0, ss = 0, n = 0;
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) { const v = L[y * w + x]; s += v; ss += v * v; n++; }
    const m = s / n;
    return { mean: m, std: Math.sqrt(Math.max(0, ss / n - m * m)) };
  }

  /** Circular fisheye: dark, flat corners around a bright centre. */
  function fisheyeScore(L, w, x0, y0, ew, eh) {
    const cw = Math.max(2, Math.round(ew * 0.1)), ch = Math.max(2, Math.round(eh * 0.1));
    const corners = [[0, 0], [ew - cw, 0], [0, eh - ch], [ew - cw, eh - ch]]
      .map(([x, y]) => regionStats(L, w, x0 + x, y0 + y, cw, ch));
    const centre = regionStats(L, w, x0 + Math.round(ew * 0.3), y0 + Math.round(eh * 0.3), Math.round(ew * 0.4), Math.round(eh * 0.4));
    const dark = corners.filter((c) => c.mean < 0.05 && c.std < 0.03).length;
    return dark >= 3 && centre.mean > 0.12 ? 1 : 0;
  }

  function edgeBlack(L, w, x0, y0, ew, eh) {
    const a = regionStats(L, w, x0, y0, 1, eh), b = regionStats(L, w, x0 + ew - 1, y0, 1, eh);
    return a.mean < 0.04 && b.mean < 0.04;
  }

  /** Measure every cue on one frame. Returns null for frames without enough detail (black, fades). */
  function frameFeatures(frame) {
    const { L, w, h } = toLuma(frame);
    // Stereo cue works on horizontal gradients of lightly smoothed luma: true disparity is
    // purely horizontal, while horizontal edges (horizons, the seam between stacked eyes)
    // carry no x-gradient and so can't fake a match between unrelated halves.
    const S = boxBlur(L, w, h, 1);
    const D = new Float32Array(L.length);
    let energy = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        D[i] = S[i + 1] - S[i - 1];
        energy += D[i] * D[i];
      }
    }
    if (energy / L.length < 2e-6) return null;

    const S2 = boxBlur(L, w, h, 2);
    const hw = w >> 1, hh = h >> 1;
    const sbs = bestNcc(D, w, 0, 0, hw, 0, hw, h, Math.max(2, Math.round(hw * 0.06)), 2);
    const tb = bestNcc(D, w, 0, 0, 0, hh, w, hh, Math.max(2, Math.round(w * 0.06)), 2);
    const regions = { mono: [0, 0, w, h], sbs: [0, 0, hw, h], tb: [0, 0, w, hh] };
    const per = {};
    for (const [k, [x0, y0, ew, eh]] of Object.entries(regions)) {
      per[k] = {
        seam: seamScore(S, w, x0, y0, ew, eh),
        pole: poleRatio(S2, w, x0, y0, ew, eh),
        fisheye: fisheyeScore(L, w, x0, y0, ew, eh),
        blackEdges: edgeBlack(L, w, x0, y0, ew, eh)
      };
    }
    return { sbs: sbs.r, sbsDx: sbs.dx, tb: tb.r, tbDx: tb.dx, per, w, h };
  }

  function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

  function aggregate(list) {
    const pick = (f) => mean(list.map(f));
    const per = {};
    for (const k of ["mono", "sbs", "tb"]) {
      per[k] = {
        seam: pick((x) => x.per[k].seam),
        pole: pick((x) => x.per[k].pole),
        fisheye: pick((x) => x.per[k].fisheye),
        blackEdges: pick((x) => (x.per[k].blackEdges ? 1 : 0))
      };
    }
    return { sbs: pick((x) => x.sbs), tb: pick((x) => x.tb), sbsDx: pick((x) => Math.abs(x.sbsDx)), per, frames: list.length };
  }

  const ln = Math.log;

  function scoreHypothesis(hyp, f, aspect) {
    const eyeAspect = hyp.stereo === "sbs" ? aspect / 2 : hyp.stereo === "tb" ? aspect * 2 : aspect;
    const cue = f.per[hyp.stereo];
    const parts = {};
    const other = Math.max(f.sbs, f.tb);
    parts.stereo = W.stereo * (hyp.stereo === "mono" ? STEREO_T - other : f[hyp.stereo] - STEREO_T - (hyp.stereo === "sbs" ? Math.max(0, f.tb - f.sbs) : Math.max(0, f.sbs - f.tb)));
    if (hyp.fov === "flat") {
      parts.aspect = -W.aspect * 0.5 * Math.min(...FLAT_ASPECTS.map((a) => Math.abs(ln(eyeAspect / a))));
      parts.seam = W.seam * (0.5 - Math.min(1, cue.seam));
      parts.pole = W.pole * Math.min(1, cue.pole - 0.5);
    } else {
      parts.aspect = -W.aspect * Math.abs(ln(eyeAspect / (hyp.fov === 360 ? 2 : 1)));
      parts.seam = W.seam * (hyp.fov === 360 ? Math.min(1, cue.seam) - 0.5 : 0.5 - Math.min(1, cue.seam));
      parts.pole = W.pole * (0.5 - Math.min(1, cue.pole));
      if (hyp.fov === 360 && cue.blackEdges > 0.5) parts.seam -= W.seam; // black borders never wrap
    }
    parts.prior = PRIOR[hyp.key] || 0;
    return { total: parts.stereo + parts.aspect + parts.seam + parts.pole + parts.prior, parts, eyeAspect };
  }

  function ratioLabel(a) {
    const known = [[2, "2:1"], [1, "1:1"], [16 / 9, "16:9"], [4 / 3, "4:3"], [0.5, "1:2"], [4, "4:1"], [32 / 9, "32:9"], [9 / 16, "9:16"]];
    for (const [v, s] of known) if (Math.abs(ln(a / v)) < 0.04) return s;
    return `${a.toFixed(2)}:1`;
  }

  function explain(best, f, aspect) {
    const reasons = [];
    const s = best.stereo;
    if (s === "sbs") reasons.push({ ok: true, text: `Left and right halves match like a stereo pair (correlation ${f.sbs.toFixed(2)})` });
    else if (s === "tb") reasons.push({ ok: true, text: `Top and bottom halves match like a stereo pair (correlation ${f.tb.toFixed(2)})` });
    else reasons.push({ ok: true, text: `Halves show different content — a single 2D view (best match ${Math.max(f.sbs, f.tb).toFixed(2)})` });

    const ea = s === "sbs" ? aspect / 2 : s === "tb" ? aspect * 2 : aspect;
    const eyeWord = s === "mono" ? "The picture" : "Each eye";
    if (best.fov === 360) reasons.push({ ok: Math.abs(ln(ea / 2)) < 0.1, text: `${eyeWord} is ${ratioLabel(ea)} — matches a 360° × 180° panorama` });
    else if (best.fov === 180) reasons.push({ ok: Math.abs(ln(ea)) < 0.1, text: `${eyeWord} is ${ratioLabel(ea)} — matches a 180° × 180° hemisphere` });
    else reasons.push({ ok: true, text: `${eyeWord} is ${ratioLabel(ea)} — a regular screen shape` });

    const cue = f.per[s];
    if (cue.seam > 0.75) reasons.push({ ok: best.fov === 360, text: "Left and right edges join seamlessly — the image wraps all the way around" });
    else if (cue.seam < 0.4) reasons.push({ ok: best.fov !== 360, text: "Left and right edges don't join — not a full 360° wrap" });
    if (cue.pole < 0.35) reasons.push({ ok: best.fov !== "flat", text: "Top and bottom rows are stretched sideways — the signature of a spherical projection" });
    else if (cue.pole > 0.6) reasons.push({ ok: best.fov === "flat", text: "No stretching at the top and bottom — looks like a normal camera view" });
    return reasons;
  }

  /**
   * frames: [{ data: RGBA Uint8(Clamped)Array, width, height }, …] (same video, different times)
   * Returns { key, confidence, level, ranking, reasons, fisheye, features } or null if undecidable.
   */
  function analyzeFrames(frames) {
    if (!frames || !frames.length) return null;
    const aspect = frames[0].width / frames[0].height;
    const feats = frames.map(frameFeatures).filter(Boolean);
    if (!feats.length) return null;
    const f = aggregate(feats);

    const scored = HYPOTHESES.map((h) => Object.assign({}, h, scoreHypothesis(h, f, aspect)));
    const max = Math.max(...scored.map((s) => s.total));
    const z = scored.reduce((s, h) => s + Math.exp(h.total - max), 0);
    for (const s of scored) s.p = Math.exp(s.total - max) / z;
    scored.sort((a, b) => b.p - a.p);
    const best = scored[0];

    const fisheye = f.per[best.stereo].fisheye > 0.5;
    const confidence = best.p;
    return {
      key: best.key,
      fov: best.fov,
      stereo: best.stereo,
      confidence,
      level: confidence >= 0.85 ? "high" : confidence >= 0.6 ? "medium" : "low",
      ranking: scored.slice(0, 3).map((s) => ({ key: s.key, p: s.p })),
      reasons: explain(best, f, aspect),
      fisheye,
      features: { sbs: f.sbs, tb: f.tb, seam: f.per[best.stereo].seam, pole: f.per[best.stereo].pole, frames: f.frames, aspect }
    };
  }

  /** Cheap prior from resolution alone (used before/without pixel analysis). */
  function fromDimensions(width, height) {
    if (!width || !height) return [];
    const a = width / height;
    const near = (x) => Math.abs(ln(a / x)) < 0.06;
    if (near(2)) return ["180-sbs", "360-mono"];
    if (near(1)) return ["360-tb", "180-mono"];
    if (near(4)) return ["360-sbs"];
    if (near(0.5)) return ["180-tb"];
    if (near(32 / 9)) return ["flat-sbs"];
    return ["flat-mono"];
  }

  return { analyzeFrames, fromDimensions, ANALYSIS_WIDTH, _internal: { frameFeatures, toLuma } };
});
