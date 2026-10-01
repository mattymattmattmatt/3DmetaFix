/*!
 * 3DmetaFix app controller — wires the engine (mp4.js), smart detect (detect.js)
 * and VR preview (viewer.js) to the page.
 */
(() => {
  "use strict";

  const MF = window.MetaFix;
  const MD = window.MetaDetect;
  const FORMATS = MF.FORMATS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const LS = "3dmetafix.";

  const DESCRIPTIONS = {
    "360-mono": "One equirectangular panorama covering every direction — the usual output of 360° cameras.",
    "360-tb": "Two full panoramas stacked, left eye on top. The common layout for stereoscopic 360°.",
    "360-sbs": "Two full panoramas side by side, left eye on the left.",
    "180-sbs": "Two 180° hemispheres side by side — the VR180 format used by 3D VR cameras and YouTube VR180.",
    "180-tb": "Two 180° hemispheres stacked, left eye on top.",
    "180-mono": "A single 180° hemisphere in front of the viewer.",
    "flat-sbs": "Regular-screen 3D with the views side by side. Shown as a 3D screen, not surround (V2 st3d).",
    "flat-tb": "Regular-screen 3D with the left view on top. Shown as a 3D screen, not surround (V2 st3d).",
    "flat-mono": "Removes every spherical and 3D tag so the video plays as a normal flat video."
  };

  // ───────────────────────── state ─────────────────────────
  const state = {
    token: 0,
    file: null,
    analysis: null,
    detection: null,
    detectStatus: "idle", // idle | running | done | unavailable
    format: "180-sbs",
    userPicked: false,
    standard: "both",
    proj: "",
    heading: "",
    crop: { enabled: false, cW: "", cH: "", fW: "", fH: "", cL: "", cT: "" },
    refStereo: null,
    plan: null,
    planError: null,
    noChange: false,
    saving: null,
    objectUrl: null,
    viewMode: "vr",
    eye: "left",
    reasonsOpen: false
  };

  // ───────────────────────── helpers ─────────────────────────
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name, cls = "") => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
  const nf = new Intl.NumberFormat();

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let x = Math.abs(n);
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return `${n < 0 ? "−" : ""}${x.toFixed(i === 0 ? 0 : x < 10 ? 2 : x < 100 ? 1 : 0)} ${u[i]}`;
  }
  function fmtTime(s) {
    if (!Number.isFinite(s) || s < 0) return "0:00";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  }
  function ratio(w, h) {
    if (!w || !h) return "";
    const known = [[2, "2:1"], [1, "1:1"], [16 / 9, "16:9"], [4 / 3, "4:3"], [0.5, "1:2"], [4, "4:1"], [32 / 9, "32:9"], [9 / 16, "9:16"], [21 / 9, "21:9"]];
    for (const [v, s] of known) if (Math.abs(Math.log(w / h / v)) < 0.02) return s;
    return `${(w / h).toFixed(2)}:1`;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (_) { /* private mode */ } }
  };
  function toast(msg, tone = "info", ms = 3200) {
    const el = document.createElement("div");
    el.className = `toast ${tone}`;
    el.innerHTML = `${icon(tone === "ok" ? "ok" : tone === "bad" ? "bad" : "info")}<span>${esc(msg)}</span>`;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  const labelOf = (key) => (FORMATS[key] ? FORMATS[key].label : key);

  // ───────────────────────── elements ─────────────────────────
  const el = {
    hero: $("#hero"), workspace: $("#workspace"), drop: $("#drop"), fileInput: $("#fileInput"),
    fileName: $("#fileName"), fileChips: $("#fileChips"),
    stage: $("#stage"), canvas: $("#vrCanvas"), video: $("#video"), guide: $("#layoutGuide"), hint: $("#stageHint"),
    badge: $("#stageBadge"), stageMsg: $("#stageMsg"), playBtn: $("#playBtn"), seek: $("#seek"), time: $("#timeLabel"),
    verdict: $("#verdict"), facts: $("#facts"),
    smart: $("#smart"), smartTitle: $("#smartTitle"), smartSub: $("#smartSub"), smartReasons: $("#smartReasons"),
    smartApply: $("#smartApplyBtn"), smartWhy: $("#smartWhyBtn"),
    fovSeg: $("#fovSeg"), stereoSeg: $("#stereoSeg"), standardSeg: $("#standardSeg"),
    diagram: $("#diagram"), formatName: $("#formatName"), formatDesc: $("#formatDesc"),
    projInput: $("#projInput"), headingInput: $("#headingInput"), cropToggle: $("#cropToggle"), cropFields: $("#cropFields"), cropWarn: $("#cropWarn"),
    refBtn: $("#refBtn"), refInput: $("#refInput"), refStatus: $("#refStatus"),
    plan: $("#planInfo"), saveBtn: $("#saveBtn"), saveLabel: $("#saveLabel"), saveSub: $("#saveSub"),
    progress: $("#progress"), progressLabel: $("#progressLabel"), progressPct: $("#progressPct"), progressFill: $("#progressFill"), progressDetail: $("#progressDetail"),
    result: $("#result"),
    boxTree: $("#boxTree"), rawMeta: $("#rawMeta"), reportJson: $("#reportJson"), techMeta: $("#techMeta")
  };

  // ───────────────────────── viewer ─────────────────────────
  let viewer = null;
  try { viewer = new window.MetaViewer(el.canvas, el.video); } catch (e) { viewer = null; }
  if (!viewer || !viewer.supported) {
    viewer = null;
    state.viewMode = "flat";
    $('#viewModeSeg [data-mode="vr"]').disabled = true;
  } else {
    viewer.onInteract = () => el.hint.classList.add("gone");
  }

  // ───────────────────────── file loading ─────────────────────────
  async function openFile(file) {
    if (!file) return;
    if (state.saving) { toast("Please wait for the current save to finish.", "info"); return; }
    const token = ++state.token;
    Object.assign(state, {
      file, analysis: null, detection: null, detectStatus: "running", userPicked: false, plan: null, planError: null, reasonsOpen: false,
      // Value overrides belong to one file; only the V1/V2 preference carries over.
      proj: "", heading: "", refStereo: null, crop: { enabled: false, cW: "", cH: "", fW: "", fH: "", cL: "", cT: "" }
    });
    syncAdvancedInputs();
    el.hero.hidden = true;
    el.workspace.hidden = false;
    $("#fixCard").hidden = false;
    el.result.hidden = true;
    el.progress.hidden = true;
    el.refStatus.textContent = "Match a known-good file exactly (all V1 values included).";
    el.refStatus.className = "help";
    el.fileName.textContent = file.name;
    el.fileName.title = file.name;
    el.fileChips.innerHTML = `<span class="chip">${fmtBytes(file.size)}</span>`;
    el.verdict.dataset.tone = "info";
    el.verdict.innerHTML = `<div class="v-icon">${icon("search")}</div><div><div class="v-title">Reading file structure…</div><div class="v-sub">Only the header is read — this is instant even for huge files.</div></div>`;
    el.facts.innerHTML = "";
    window.scrollTo({ top: 0, behavior: "smooth" });

    let a;
    try {
      a = await MF.analyze(file, { name: file.name });
    } catch (e) {
      if (token !== state.token) return;
      showFatal(e);
      startPreview(file, token, true);
      return;
    }
    if (token !== state.token) return;
    state.analysis = a;

    const eff = a.meta.effective;
    const prior = MD.fromDimensions(a.video && a.video.width, a.video && a.video.height);
    state.format = (eff && eff.key) || prior[0] || "180-sbs";
    state.noChange = false;
    renderChips();
    renderDiagnosis();
    renderTech();
    applyFormatUI();
    recomputePlan();
    renderSmart();
    startPreview(file, token, false);
  }

  function showFatal(e) {
    $("#fixCard").hidden = true;
    el.verdict.dataset.tone = "bad";
    el.verdict.innerHTML = `<div class="v-icon">${icon("bad")}</div><div><div class="v-title">${esc(e.message || String(e))}</div>${e.hint ? `<div class="v-sub">${esc(e.hint)}</div>` : ""}</div>`;
    el.facts.innerHTML = "";
    state.plan = null;
    state.planError = e;
    state.detectStatus = "unavailable";
    renderSmart();
    renderPlan();
    el.boxTree.innerHTML = "";
    el.rawMeta.textContent = "";
    el.reportJson.textContent = "";
    el.techMeta.textContent = "";
  }

  // ───────────────────────── preview + smart detect ─────────────────────────
  function waitFor(target, ok, bad, ms) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => () => { cleanup(); fn(v); };
      const onOk = done(resolve), onBad = done(reject, new Error("media error"));
      const timer = setTimeout(done(reject, new Error("timeout")), ms);
      function cleanup() { clearTimeout(timer); target.removeEventListener(ok, onOk); target.removeEventListener(bad, onBad); }
      target.addEventListener(ok, onOk, { once: true });
      target.addEventListener(bad, onBad, { once: true });
    });
  }

  function seekTo(t) {
    const v = el.video;
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return Promise.resolve();
    const p = waitFor(v, "seeked", "error", 6000);
    v.currentTime = t;
    return p;
  }

  async function startPreview(file, token, analysisFailed) {
    const v = el.video;
    v.pause();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    el.stageMsg.hidden = false;
    el.stageMsg.innerHTML = `<div><b>Loading preview…</b>Decoding a few frames in your browser.</div>`;
    el.hint.classList.remove("gone");
    setPlaying(false);
    const loaded = waitFor(v, "loadeddata", "error", 20000);
    v.src = state.objectUrl;
    v.load();
    try {
      await loaded;
    } catch (_) {
      if (token !== state.token) return;
      const codec = state.analysis && state.analysis.video ? state.analysis.video.codecName : null;
      el.stageMsg.innerHTML = analysisFailed || !codec
        ? `<div><b>Preview not available</b>This file couldn't be played.</div>`
        : `<div><b>Preview not available</b>Your browser can't decode ${esc(codec)} video. Everything else still works.</div>`;
      state.detectStatus = "unavailable";
      renderSmart();
      return;
    }
    if (token !== state.token) return;
    el.stageMsg.hidden = true;
    syncViewer();
    updateTime();
    if (analysisFailed) return;

    let frames = [];
    try { frames = await grabFrames(token); } catch (_) { frames = []; }
    if (token !== state.token) return;
    const det = frames.length ? MD.analyzeFrames(frames) : null;
    state.detection = det;
    state.detectStatus = frames.length ? "done" : "unavailable";
    autoSelectFromDetection();
    renderSmart();
    renderDiagnosis();
  }

  async function grabFrames(token) {
    const v = el.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return [];
    const dur = v.duration;
    const times = Number.isFinite(dur) && dur > 1 ? [0.12, 0.37, 0.62, 0.87].map((f) => f * dur) : [Math.min(0.5, (dur || 0) / 2)];
    const cw = Math.max(32, Math.round(Math.sqrt((4 * 320 * 160 * vw) / vh)));
    const ch = Math.max(16, Math.round((cw * vh) / vw));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const frames = [];
    for (const t of times) {
      if (token !== state.token) return [];
      try { await seekTo(t); } catch (_) { continue; }
      ctx.drawImage(v, 0, 0, cw, ch);
      frames.push({ data: ctx.getImageData(0, 0, cw, ch).data, width: cw, height: ch });
    }
    try { await seekTo(times[0]); } catch (_) { /* keep whatever frame is showing */ }
    return frames;
  }

  function autoSelectFromDetection() {
    const d = state.detection;
    if (!d || state.userPicked || !state.analysis) return;
    const eff = state.analysis.meta.effective;
    if (eff && eff.key === d.key) return;
    const strongEnough = eff ? d.level === "high" : d.level !== "low";
    if (strongEnough && FORMATS[d.key]) {
      state.format = d.key;
      applyFormatUI();
      recomputePlan();
    }
  }

  function syncViewer() {
    const f = FORMATS[state.format];
    if (viewer) {
      viewer.setFormat(f);
      viewer.setEye(state.eye);
    }
    el.stage.dataset.mode = state.viewMode;
    $$("#viewModeSeg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === state.viewMode)));
    const stereo = f.stereo !== "mono";
    $("#eyeSeg").hidden = !stereo || state.viewMode !== "vr";
    $$("#eyeSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.eye === state.eye)));
    const eyeTxt = stereo ? ` · ${state.eye === "anaglyph" ? "red/cyan 3D" : state.eye + " eye"}` : "";
    el.badge.textContent = state.viewMode === "vr" ? `Previewing as ${f.short}${eyeTxt}` : "Full frame";
    el.hint.hidden = state.viewMode !== "vr" || f.fov === "flat";
    updateGuide();
  }

  function updateGuide() {
    const v = el.video;
    const g = el.guide;
    if (!v.videoWidth) { g.innerHTML = ""; return; }
    const r = el.stage.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    Object.assign(g.style, { left: `${(r.width - w) / 2}px`, top: `${(r.height - h) / 2}px`, width: `${w}px`, height: `${h}px` });
    const st = FORMATS[state.format].stereo;
    const half = (x, y, ww, hh, txt) => `<div class="half" style="left:${x}%;top:${y}%;width:${ww}%;height:${hh}%"><span>${txt}</span></div>`;
    g.innerHTML = st === "sbs" ? half(0, 0, 50, 100, "Left eye") + half(50, 0, 50, 100, "Right eye")
      : st === "tb" ? half(0, 0, 100, 50, "Left eye") + half(0, 50, 100, 50, "Right eye") : "";
  }

  function setPlaying(p) {
    el.playBtn.classList.toggle("playing", p);
    el.playBtn.setAttribute("aria-label", p ? "Pause" : "Play");
  }
  function updateTime() {
    const v = el.video;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const pct = d ? (v.currentTime / d) * 100 : 0;
    el.seek.value = String(Math.round(pct * 10));
    el.seek.style.setProperty("--p", `${pct}%`);
    el.time.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
  }

  // ───────────────────────── rendering: file + diagnosis ─────────────────────────
  function renderChips() {
    const a = state.analysis;
    const v = a.video;
    const chips = [];
    if (v && v.width) chips.push(`<span class="chip accent">${v.width} × ${v.height}</span>`, `<span class="chip">${ratio(v.width, v.height)}</span>`);
    if (v && v.codecName) chips.push(`<span class="chip">${esc(v.codecName)}</span>`);
    if (v && v.sampleCount && v.duration && v.timescale) {
      const fps = v.sampleCount / (v.duration / v.timescale);
      if (fps > 1 && fps < 1000) chips.push(`<span class="chip">${fps.toFixed(fps % 1 > 0.05 && fps % 1 < 0.95 ? 2 : 0)} fps</span>`);
    }
    if (a.duration) chips.push(`<span class="chip">${fmtTime(a.duration)}</span>`);
    chips.push(`<span class="chip">${fmtBytes(a.size)}</span>`, `<span class="chip">${a.container.toUpperCase()}</span>`);
    el.fileChips.innerHTML = chips.join("");
  }

  function describeV1(v1) {
    const t = v1.tags;
    const parts = [`ProjectionType <code>${esc(t.ProjectionType || "—")}</code>`];
    if (t.StereoMode) parts.push(`StereoMode <code>${esc(t.StereoMode)}</code>`);
    if (t.InitialViewHeadingDegrees != null) parts.push(`heading <code>${esc(t.InitialViewHeadingDegrees)}°</code>`);
    if (t.FullPanoWidthPixels) parts.push("crop fields");
    return parts.join(" · ");
  }
  function describeV2(v2) {
    const m = v2.meaning;
    const parts = [];
    if (v2.sv3d) {
      const sv = v2.sv3d;
      if (sv.projection === "equirectangular" && m.fov) parts.push(`${Math.round(m.fov)}° equirectangular`);
      else parts.push(sv.projection || "unknown projection");
    } else {
      parts.push("flat (st3d only)");
    }
    const st = { mono: "mono", sbs: "side-by-side", tb: "top-bottom", custom: "custom layout" }[m.stereo] || m.stereo;
    parts.push(m.rightLeft ? "side-by-side (right eye first)" : st);
    if (v2.sv3d && v2.sv3d.source) parts.push(`by ${esc(v2.sv3d.source)}`);
    return parts.join(" · ");
  }

  function renderDiagnosis() {
    const a = state.analysis;
    if (!a) return;
    const m = a.meta;
    const eff = m.effective;
    const d = state.detection;
    const mismatch = d && eff && eff.key && d.level !== "low" && d.key !== eff.key;
    let tone, title, sub, ic;
    if (!a.video) {
      tone = "bad"; ic = "bad"; title = "No video track found"; sub = "This file doesn't contain a video stream to tag.";
    } else if (m.conflicts.length) {
      tone = "warn"; ic = "warn"; title = "Conflicting VR metadata"; sub = m.conflicts[0] + " Players may disagree on how to show it.";
    } else if (mismatch) {
      tone = "warn"; ic = "warn"; title = "Metadata doesn't match the picture";
      sub = `Tagged as ${labelOf(eff.key)}, but the picture looks like ${labelOf(d.key)}.`;
    } else if (eff) {
      tone = "ok"; ic = "ok";
      title = eff.key ? `Tagged as ${labelOf(eff.key)}` : "Has VR metadata (unusual format)";
      sub = eff.key && eff.fov === "flat" ? "Players will show this as a 3D screen." : "VR players and YouTube will recognise this as immersive video.";
    } else if (d && d.key === "flat-mono" && d.level !== "low") {
      tone = "info"; ic = "info"; title = "Regular video — no VR metadata"; sub = "It looks like a normal flat video, so it doesn't need any.";
    } else {
      tone = "warn"; ic = "warn"; title = "No VR metadata"; sub = "Players and YouTube will show this as a regular flat video.";
    }
    el.verdict.dataset.tone = tone;
    el.verdict.innerHTML = `<div class="v-icon">${icon(ic)}</div><div><div class="v-title">${esc(title)}</div><div class="v-sub">${esc(sub)}</div></div>`;

    const rows = [];
    const row = (cls, ic2, label, value) => rows.push(`<li>${icon(ic2, cls)}<div><div class="f-label">${label}</div><div class="f-value">${value}</div></div></li>`);
    if (m.v1) {
      if (!m.v1.wellFormed) row("warn", "warn", "Spherical V1 (XML)", `Present but malformed — ${describeV1(m.v1)}`);
      else if (m.v1.location !== "trak") row("warn", "warn", "Spherical V1 (XML)", `In the wrong box (<code>${esc(m.v1.location)}</code>) — ${describeV1(m.v1)}`);
      else row("ok", "ok", "Spherical V1 (XML)", describeV1(m.v1));
    } else row("off", "minus", "Spherical V1 (XML)", "Not present");
    if (m.v2) row("ok", "ok", "Spherical V2 (<code>st3d</code> / <code>sv3d</code>)", describeV2(m.v2));
    else row("off", "minus", "Spherical V2 (<code>st3d</code> / <code>sv3d</code>)", "Not present");
    if (m.apple) row("info", "info", "Apple (<code>vexu</code>)", esc(m.apple.meaning ? m.apple.meaning.label : "Present") + " — kept as is");
    if (m.spatialAudio) {
      const s = m.spatialAudio;
      row("ok", "ok", "Spatial audio (<code>SA3D</code>)", s.order != null ? `Ambisonic order ${s.order} · ${s.channels} channels (${esc(s.ordering)}/${esc(s.normalization)})` : "Present");
    }
    const layout = a.fragmented ? "fragmented" : a.faststart ? "header first (streaming-ready)" : "header at end";
    const tracks = a.tracks.map((t) => ({ vide: "video", soun: "audio" }[t.handler] || t.handler || "?"));
    row("info", "info", "Container", `${a.container.toUpperCase()} · ${layout} · ${tracks.length} track${tracks.length === 1 ? "" : "s"} (${esc(tracks.join(", "))})`);
    for (const w of a.warnings) row("warn", "warn", "Note", esc(w));
    el.facts.innerHTML = rows.join("");
  }

  function renderSmart() {
    const s = el.smart;
    const d = state.detection;
    el.smartReasons.hidden = true;
    el.smartReasons.innerHTML = "";
    el.smartWhy.hidden = true;
    el.smartApply.hidden = true;
    const extra = s.querySelector(".smart-warn");
    if (extra) extra.remove();
    if (state.detectStatus === "running") {
      s.dataset.state = "pending";
      el.smartTitle.textContent = "Smart detect is looking at the picture…";
      el.smartSub.textContent = "Sampling frames to recognise the projection and stereo layout.";
      return;
    }
    if (state.detectStatus === "unavailable" || !d) {
      s.dataset.state = "unavailable";
      el.smartTitle.textContent = "Smart detect unavailable";
      const a = state.analysis;
      const prior = a && a.video ? MD.fromDimensions(a.video.width, a.video.height) : [];
      el.smartSub.textContent = (state.detection === null && state.detectStatus === "done" ? "Not enough detail in the sampled frames." : "The picture couldn't be decoded in this browser.") +
        (prior.length ? ` By resolution it's most likely ${prior.map(labelOf).join(" or ")}.` : "");
      return;
    }
    s.dataset.state = "done";
    const matches = d.key === state.format;
    el.smartTitle.innerHTML = `Looks like <b>${esc(labelOf(d.key))}</b>`;
    el.smartSub.innerHTML = `<span class="level ${d.level}">${d.level} confidence</span> ${matches ? "· selected below" : `· you've selected ${esc(labelOf(state.format))}`}`;
    el.smartApply.hidden = matches;
    el.smartWhy.hidden = false;
    el.smartWhy.textContent = state.reasonsOpen ? "Hide" : "Why?";
    el.smartReasons.innerHTML = d.reasons.map((r) => `<li class="${r.ok ? "" : "no"}">${icon(r.ok ? "check" : "warn")}<span>${esc(r.text)}</span></li>`).join("");
    el.smartReasons.hidden = !state.reasonsOpen;
    if (d.fisheye) {
      const w = document.createElement("div");
      w.className = "smart-warn";
      w.innerHTML = `${icon("warn")}<span>This looks like circular fisheye footage. Metadata can't reshape pixels — convert it to equirectangular in your camera's software first.</span>`;
      $(".smart-body", s).appendChild(w);
    }
  }

  // ───────────────────────── rendering: format + plan ─────────────────────────
  function diagramSvg(key) {
    const f = FORMATS[key];
    const a = state.analysis && state.analysis.video;
    let ar = a && a.width ? a.width / a.height : f.fov === 360 ? (f.stereo === "tb" ? 1 : f.stereo === "sbs" ? 4 : 2) : f.fov === 180 ? (f.stereo === "sbs" ? 2 : f.stereo === "tb" ? 0.5 : 1) : f.stereo === "sbs" ? 32 / 9 : f.stereo === "tb" ? 8 / 9 : 16 / 9;
    const W = 112, H = 72, pad = 4;
    let w = W - pad * 2, h = w / ar;
    if (h > H - pad * 2) { h = H - pad * 2; w = h * ar; }
    const x0 = (W - w) / 2, y0 = (H - h) / 2;
    const eyes = f.stereo === "sbs" ? [[x0, y0, w / 2, h, "L"], [x0 + w / 2, y0, w / 2, h, "R"]]
      : f.stereo === "tb" ? [[x0, y0, w, h / 2, "L"], [x0, y0 + h / 2, w, h / 2, "R"]] : [[x0, y0, w, h, ""]];
    const deco = (x, y, ew, eh) => {
      const cx = x + ew / 2, cy = y + eh / 2;
      if (f.fov === 360) return `<path d="M${x} ${cy}H${x + ew}M${cx} ${y}V${y + eh}" /><ellipse cx="${cx}" cy="${cy}" rx="${ew / 4}" ry="${eh / 2}" /><path d="M${x} ${y + eh * 0.25}Q${cx} ${y + eh * 0.12} ${x + ew} ${y + eh * 0.25}M${x} ${y + eh * 0.75}Q${cx} ${y + eh * 0.88} ${x + ew} ${y + eh * 0.75}" />`;
      if (f.fov === 180) return `<ellipse cx="${cx}" cy="${cy}" rx="${ew * 0.42}" ry="${eh * 0.42}" /><path d="M${cx - ew * 0.42} ${cy}H${cx + ew * 0.42}M${cx} ${cy - eh * 0.42}V${cy + eh * 0.42}" /><ellipse cx="${cx}" cy="${cy}" rx="${ew * 0.16}" ry="${eh * 0.42}" />`;
      return `<rect x="${x + ew * 0.2}" y="${y + eh * 0.24}" width="${ew * 0.6}" height="${eh * 0.52}" rx="2" />`;
    };
    const body = eyes.map(([x, y, ew, eh, lab]) =>
      `<rect x="${x + 1.5}" y="${y + 1.5}" width="${ew - 3}" height="${eh - 3}" rx="4" fill="url(#dg)" stroke="var(--accent-line)" />` +
      `<g fill="none" stroke="var(--accent)" stroke-opacity=".55" stroke-width="1">${deco(x + 1.5, y + 1.5, ew - 3, eh - 3)}</g>` +
      (lab ? `<text x="${x + ew / 2}" y="${y + eh / 2 + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--text)">${lab}</text>` : "")).join("");
    return `<svg viewBox="0 0 ${W} ${H}"><defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b6cff" stop-opacity=".22"/><stop offset="1" stop-color="#36cfff" stop-opacity=".14"/></linearGradient></defs>${body}</svg>`;
  }

  function applyFormatUI() {
    const f = FORMATS[state.format];
    $$("#fovSeg button").forEach((b) => b.setAttribute("aria-checked", String(String(f.fov) === b.dataset.fov)));
    $$("#stereoSeg button").forEach((b) => b.setAttribute("aria-checked", String(f.stereo === b.dataset.stereo)));
    $$("#standardSeg button").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.standard === state.standard));
      b.disabled = f.fov === "flat";
    });
    el.diagram.innerHTML = diagramSvg(state.format);
    el.formatName.textContent = f.label;
    el.formatDesc.textContent = DESCRIPTIONS[state.format];
    const remove = state.format === "flat-mono";
    el.saveBtn.classList.toggle("danger", remove);
    el.saveLabel.textContent = remove ? "Save without VR metadata" : "Save fixed video";
    const auto = f.fov === 180 ? "half_equirectangular" : f.fov === 360 ? "equirectangular" : "—";
    el.projInput.placeholder = `auto (${auto})`;
    el.headingInput.placeholder = f.fov === "flat" ? "—" : `auto (${defaultHeading()})`;
    el.projInput.disabled = el.headingInput.disabled = el.cropToggle.disabled = f.fov === "flat" || state.standard === "v2";
    syncViewer();
    renderSmart();
  }

  function defaultHeading() {
    return FORMATS[state.format].fov === 180 ? 180 : 0;
  }

  function cropValues() {
    if (!state.crop.enabled) return null;
    const o = {};
    for (const k of ["cW", "cH", "fW", "fH", "cL", "cT"]) o[k] = Math.max(0, Math.round(Number(state.crop[k]) || 0));
    return o;
  }

  function validateCrop() {
    const c = cropValues();
    if (!c) { el.cropWarn.hidden = true; return; }
    const msgs = [];
    if (!c.cW || !c.cH || !c.fW || !c.fH) msgs.push("Widths and heights must be greater than 0.");
    if (c.cW + c.cL > c.fW || c.cH + c.cT > c.fH) msgs.push("The cropped area must fit inside the full panorama.");
    el.cropWarn.hidden = !msgs.length;
    el.cropWarn.textContent = msgs.join(" ") + (msgs.length ? " Players may ignore these values." : "");
  }

  function currentSpecOptions() {
    const heading = state.heading === "" ? defaultHeading() : Number(state.heading);
    return {
      format: state.format,
      standard: state.standard,
      v1: {
        projectionType: state.proj.trim() || undefined,
        stereoMode: state.refStereo != null && FORMATS[state.format].stereo !== "mono" ? state.refStereo : undefined,
        heading: Number.isFinite(heading) ? heading : undefined,
        crop: cropValues()
      }
    };
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function recomputePlan() {
    const a = state.analysis;
    if (!a) { renderPlan(); return; }
    try {
      const spec = MF.buildSpec(currentSpecOptions());
      state.plan = MF.plan(a, spec);
      state.planError = null;
      const s = state.plan.splices;
      state.noChange = s.length === 1 && s[0].start === a._raw.moovBox.start && sameBytes(s[0].bytes, a._raw.moovU8);
    } catch (e) {
      state.plan = null;
      state.planError = e;
      state.noChange = false;
    }
    renderPlan();
  }
  const recomputePlanSoon = debounce(recomputePlan, 140);

  function renderPlan() {
    const p = state.plan;
    const rows = [];
    const row = (txt, ic = "check", cls = "") => rows.push(`<div class="plan-row ${cls}">${icon(ic)}<span>${txt}</span></div>`);
    if (state.planError) {
      row(esc(state.planError.message || String(state.planError)), "warn", "warn");
    } else if (p && state.noChange) {
      row("This file already has exactly these settings — nothing to change.", "ok");
    } else if (p) {
      const spec = p.spec;
      const what = [];
      if (spec.v1) what.push("V1 XML");
      if (spec.v2) what.push(spec.v2.projection ? "V2 <code>st3d</code>/<code>sv3d</code>".replace(spec.v2.stereo == null ? "<code>st3d</code>/" : "", "") : "V2 <code>st3d</code>");
      const removed = p.removed.v1 + p.removed.v2;
      if (what.length) row(`Writes ${what.join(" + ")} to ${p.videoTracks} video track${p.videoTracks === 1 ? "" : "s"}${removed ? `, replacing ${removed} existing tag${removed === 1 ? "" : "s"}` : ""}.`, "wand");
      else row(`Removes ${removed} spherical/3D tag${removed === 1 ? "" : "s"}.`, "eraser");
      const strat = {
        "same-size": "Header keeps its exact size — no other byte in the file moves.",
        padding: "Fits into the file's spare padding — no media byte moves.",
        tail: "Header sits at the end of the file — the media data is untouched.",
        remap: `Header grows by ${fmtBytes(p.headerDelta)}; ${nf.format(p.remapped)} media offset${p.remapped === 1 ? " is" : "s are"} remapped to match (streaming layout kept).`
      }[p.strategy];
      if (strat) row(strat, "zap");
      for (const n of p.notes) row(esc(n), "info");
      const fov = FORMATS[state.format].fov;
      if (spec.v1 && spec.v2 && spec.v2.projection) {
        const pt = spec.v1.projectionType.toLowerCase();
        if (fov === 360 && pt.includes("half")) row(`V1 ProjectionType <code>${esc(spec.v1.projectionType)}</code> means 180°, but V2 says 360° — players will disagree.`, "warn", "warn");
        if (fov === 180 && pt === "equirectangular" && !spec.v1.crop) row("V1 <code>equirectangular</code> without crop fields means 360°, but V2 says 180° — players reading V1 will disagree.", "warn", "warn");
      }
      row(`Output: ${fmtBytes(p.outputSize)} · same audio & video streams, bit for bit.`, "gem");
    }
    el.plan.innerHTML = rows.join("");
    const disabled = !p || !!state.planError || state.noChange || !!state.saving;
    el.saveBtn.disabled = disabled;
    el.saveSub.textContent = state.noChange ? "Pick a different format to make a change." : "Creates a new file — your original is never modified.";
  }

  // ───────────────────────── tech panel ─────────────────────────
  function renderTech() {
    const a = state.analysis;
    const tree = MF.boxTree(a);
    let count = 0;
    const node = (n, depth) => {
      count++;
      const note = n.note ? `<span class="n ${/V1|V2|Spatial/.test(n.note) ? "hot" : ""}">${esc(n.note)}</span>` : "";
      const line = `<span class="t">${esc(n.type)}</span>${note}<span class="s">${fmtBytes(n.size)}</span><span class="o">@${nf.format(n.offset)}</span>`;
      if (!n.children) return `<div class="leaf">${line}</div>`;
      const open = depth < 1 || n.type === "trak" ? " open" : "";
      return `<details${open}><summary>${line}</summary><div class="children">${n.children.map((c) => node(c, depth + 1)).join("")}</div></details>`;
    };
    // Collapse long runs of fragment boxes so huge fragmented files stay readable.
    const parts = [];
    for (let i = 0; i < tree.length; i++) {
      const isFrag = (t) => t && (t.type === "moof" || t.type === "mdat");
      let j = i;
      while (isFrag(tree[j])) j++;
      if (j - i > 12) {
        for (let k = i; k < i + 4; k++) parts.push(node(tree[k], 0));
        parts.push(`<div class="leaf run">… ${nf.format(j - i - 6)} more moof/mdat fragment boxes …</div>`);
        for (let k = j - 2; k < j; k++) parts.push(node(tree[k], 0));
        i = j - 1;
      } else {
        parts.push(node(tree[i], 0));
      }
    }
    el.boxTree.innerHTML = parts.join("");
    el.techMeta.textContent = `${nf.format(count)} boxes · header ${fmtBytes(a._raw.moovBox.size)} · parsed in ${a.elapsedMs} ms`;

    const m = a.meta;
    const out = [];
    if (m.v1) out.push(`── Spherical V1 · uuid ${MF.GS_UUID_HEX} (in ${m.v1.location}) ──\n${m.v1.xml.replace(/></g, ">\n<").replace(/\u0000+$/, "")}`);
    else out.push("── Spherical V1 ── not present");
    if (m.v2) out.push(`── Spherical V2 ──\n${JSON.stringify({ st3d: m.v2.st3d, sv3d: m.v2.sv3d }, null, 2)}`);
    else out.push("── Spherical V2 ── not present");
    if (m.apple) out.push(`── Apple vexu ──\n${JSON.stringify(m.apple, null, 2)}`);
    if (m.spatialAudio) out.push(`── SA3D spatial audio ──\n${JSON.stringify(m.spatialAudio, null, 2)}`);
    el.rawMeta.textContent = out.join("\n\n");
    el.reportJson.textContent = JSON.stringify(reportObject(), null, 2);
  }

  function reportObject() {
    const r = MF.report(state.analysis);
    if (state.detection) r.smartDetect = { key: state.detection.key, confidence: Number(state.detection.confidence.toFixed(3)), reasons: state.detection.reasons.map((x) => x.text), fisheye: state.detection.fisheye };
    r.tool = "3DmetaFix";
    return r;
  }

  // ───────────────────────── saving ─────────────────────────
  function outputName(name, key) {
    const m = name.match(/^(.*?)(\.[^.]+)?$/);
    let base = m[1] || "video";
    const ext = (m[2] || ".mp4").toLowerCase();
    const suffixes = Object.values(FORMATS).map((f) => f.suffix).sort((x, y) => y.length - x.length);
    for (const s of suffixes) if (base.toLowerCase().endsWith("_" + s)) { base = base.slice(0, -(s.length + 1)); break; }
    return `${base}_${FORMATS[key].suffix}${ext}`;
  }

  function showProgress(label, frac, detail, indeterminate) {
    el.progress.hidden = false;
    el.progressLabel.textContent = label;
    el.progressPct.textContent = frac == null ? "" : `${Math.floor(frac * 100)}%`;
    el.progressFill.style.width = `${Math.max(0, Math.min(1, frac || 0)) * 100}%`;
    el.progressFill.parentElement.classList.toggle("indeterminate", !!indeterminate);
    el.progressDetail.textContent = detail || "";
  }

  async function writeToDisk(handle, blob, ctl) {
    const writable = await handle.createWritable();
    ctl.writable = writable;
    const total = blob.size;
    const CHUNK = 32 * 1024 * 1024;
    const t0 = performance.now();
    let off = 0;
    try {
      while (off < total) {
        if (ctl.cancelled) throw new DOMException("Cancelled", "AbortError");
        const end = Math.min(total, off + CHUNK);
        await writable.write(blob.slice(off, end));
        off = end;
        const secs = (performance.now() - t0) / 1000;
        const speed = off / Math.max(0.001, secs);
        const left = (total - off) / Math.max(1, speed);
        showProgress("Writing…", off / total, `${fmtBytes(off)} of ${fmtBytes(total)} · ${fmtBytes(speed)}/s${off < total ? ` · ${Math.ceil(left)} s left` : ""}`);
      }
      showProgress("Finishing up…", 1, "Your browser is finalising the file", true);
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (_) { /* already closed */ }
      throw e;
    }
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  async function save() {
    const p = state.plan, a = state.analysis, file = state.file;
    if (!p || !a || state.saving || state.noChange) return;
    const name = outputName(file.name, state.format);
    const mov = a.container === "mov" || /\.mov$/i.test(name);
    const mime = mov ? "video/quicktime" : "video/mp4";
    const blob = MF.buildBlob(file, p, mime);
    const ctl = { cancelled: false, writable: null };
    let handle = null;

    if ("showSaveFilePicker" in window) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          id: "metafix-save",
          types: [{ description: mov ? "QuickTime movie" : "MP4 video", accept: mov ? { "video/quicktime": [".mov"] } : { "video/mp4": [".mp4", ".m4v"] } }]
        });
      } catch (e) {
        if (e && e.name === "AbortError") return; // user closed the dialog
        handle = null; // picker unavailable here — fall back to a download
      }
    }

    state.saving = ctl;
    el.saveBtn.disabled = true;
    el.result.hidden = true;
    window.addEventListener("beforeunload", guardUnload);
    let target = null, verifyBlob = blob, savedName = name;
    try {
      if (handle) {
        await writeToDisk(handle, blob, ctl);
        target = "disk";
        savedName = handle.name || name;
        try { verifyBlob = await handle.getFile(); } catch (_) { verifyBlob = blob; target = "disk-unverified"; }
      } else {
        showProgress("Preparing download…", null, "", true);
        download(blob, name);
        target = "download";
      }
      showProgress("Verifying…", null, "Re-reading the new file and comparing media bytes with the original", true);
      const v = await MF.verify(file, verifyBlob, a, p);
      el.progress.hidden = true;
      showResult(v, savedName, target, handle);
    } catch (e) {
      el.progress.hidden = true;
      if (e && e.name === "AbortError") toast("Saving cancelled.", "info");
      else showError(e);
    } finally {
      state.saving = null;
      window.removeEventListener("beforeunload", guardUnload);
      renderPlan();
    }
  }

  function guardUnload(e) { e.preventDefault(); e.returnValue = ""; }

  function showResult(v, name, target, handle) {
    const tone = v.ok ? "ok" : "bad";
    const where = target === "download" ? "Downloaded" : "Saved";
    const title = v.ok ? `${where} and verified` : `${where}, but verification found a problem`;
    const scope = target === "disk" ? "Checked the file on disk" : target === "download" ? "Checked the downloaded data before it left the browser" : "Checked the written data";
    const checks = v.checks.map((c) => `<li class="${c.ok ? "" : "fail"}">${icon(c.ok ? "check" : "bad")}<span>${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</span></li>`).join("");
    el.result.dataset.tone = tone;
    el.result.innerHTML = `
      <div class="result-hd">${icon(v.ok ? "ok" : "bad")}<span>${esc(title)}</span></div>
      <div class="result-file">${esc(name)}</div>
      <ul class="checks">${checks}</ul>
      <div class="help" style="margin-top:10px">${esc(scope)}.</div>
      <div class="result-actions">
        ${handle ? `<button class="btn sm" type="button" data-act="inspect">${icon("search")}Inspect saved file</button>` : ""}
        <button class="btn sm" type="button" data-act="another">${icon("upload")}Fix another video</button>
      </div>`;
    el.result.hidden = false;
    el.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const ins = $('[data-act="inspect"]', el.result);
    if (ins) ins.addEventListener("click", async () => { try { openFile(await handle.getFile()); } catch (e) { showError(e); } });
    $('[data-act="another"]', el.result).addEventListener("click", () => el.fileInput.click());
    toast(v.ok ? `${where} ${name}` : "Verification failed — see details", v.ok ? "ok" : "bad");
  }

  function showError(e) {
    let msg = (e && e.message) || String(e);
    if (e && e.name === "NotReadableError") msg = "The original file changed or became unreadable while saving (did you overwrite it?). Re-open it and try again.";
    if (e && e.name === "NotAllowedError") msg = "Your browser didn't allow writing to that location. Try another folder.";
    el.result.dataset.tone = "bad";
    el.result.innerHTML = `<div class="result-hd">${icon("bad")}<span>Couldn't save</span></div><div class="help" style="margin-top:6px">${esc(msg)}</div>`;
    el.result.hidden = false;
  }

  // ───────────────────────── reference matching ─────────────────────────
  async function applyReference(file) {
    el.refStatus.className = "help";
    el.refStatus.textContent = `Reading ${file.name}…`;
    try {
      const r = await MF.analyze(file, { name: file.name });
      const m = r.meta;
      const eff = m.effective;
      if (!eff) {
        el.refStatus.className = "help bad";
        el.refStatus.textContent = `${file.name} has no VR metadata to copy.`;
        return;
      }
      const v1 = m.v1;
      if (eff.key) state.format = eff.key;
      state.standard = m.v1 && m.v2 ? "both" : m.v1 ? "v1" : "v2";
      if (FORMATS[state.format].fov === "flat") state.standard = "both";
      state.proj = v1 && v1.tags.ProjectionType ? v1.tags.ProjectionType : "";
      state.heading = v1 && v1.tags.InitialViewHeadingDegrees != null ? String(Math.round(Number(v1.tags.InitialViewHeadingDegrees)) || 0) : "";
      state.refStereo = v1 && v1.tags.StereoMode ? v1.tags.StereoMode : null;
      const t = v1 ? v1.tags : {};
      const hasCrop = v1 && t.FullPanoWidthPixels != null;
      state.crop = {
        enabled: !!hasCrop,
        cW: t.CroppedAreaImageWidthPixels || "", cH: t.CroppedAreaImageHeightPixels || "",
        fW: t.FullPanoWidthPixels || "", fH: t.FullPanoHeightPixels || "",
        cL: t.CroppedAreaLeftPixels || "", cT: t.CroppedAreaTopPixels || ""
      };
      state.userPicked = true;
      syncAdvancedInputs();
      applyFormatUI();
      recomputePlan();
      saveAdvanced();
      const std = { both: "V1 + V2", v1: "V1", v2: "V2" }[state.standard];
      el.refStatus.className = "help ok";
      el.refStatus.textContent = `Matched ${file.name}: ${eff.key ? labelOf(eff.key) : "custom format"} (${std}).`;
      toast("Settings copied from reference", "ok");
    } catch (e) {
      el.refStatus.className = "help bad";
      el.refStatus.textContent = `Couldn't read ${file.name}: ${e.message || e}`;
    }
  }

  // ───────────────────────── advanced settings persistence ─────────────────────────
  function syncAdvancedInputs() {
    el.projInput.value = state.proj;
    el.headingInput.value = state.heading;
    el.cropToggle.checked = state.crop.enabled;
    el.cropFields.hidden = !state.crop.enabled;
    $$("[data-crop]").forEach((i) => { i.value = state.crop[i.dataset.crop]; });
    validateCrop();
    updateAdvCount();
  }
  function updateAdvCount() {
    const n = (state.proj.trim() ? 1 : 0) + (state.heading !== "" ? 1 : 0) + (state.crop.enabled ? 1 : 0) + (state.refStereo != null ? 1 : 0) + (state.standard !== "both" ? 1 : 0);
    const c = $("#advCount");
    c.hidden = !n;
    c.textContent = `${n} custom`;
  }
  function saveAdvanced() {
    store.set("standard", state.standard);
    updateAdvCount();
  }
  function loadAdvanced() {
    const std = store.get("standard", "both");
    if (["both", "v1", "v2"].includes(std)) state.standard = std;
    syncAdvancedInputs();
  }

  // ───────────────────────── events ─────────────────────────
  el.drop.addEventListener("click", () => el.fileInput.click());
  el.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); } });
  el.fileInput.addEventListener("change", () => { const f = el.fileInput.files[0]; el.fileInput.value = ""; if (f) openFile(f); });
  $("#openAnotherBtn").addEventListener("click", () => el.fileInput.click());

  // Drag & drop anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (el.hero.hidden) $("#dropVeil").hidden = false;
    else el.drop.classList.add("over");
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { $("#dropVeil").hidden = true; el.drop.classList.remove("over"); }
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $("#dropVeil").hidden = true;
    el.drop.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  // Format pickers.
  el.fovSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fov]");
    if (!b) return;
    const fov = b.dataset.fov;
    const key = `${fov}-${FORMATS[state.format].stereo}`;
    if (!FORMATS[key] || key === state.format) return;
    if (state.proj || state.refStereo != null) { state.proj = ""; state.refStereo = null; syncAdvancedInputs(); }
    state.format = key;
    state.userPicked = true;
    applyFormatUI();
    recomputePlan();
  });
  el.stereoSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-stereo]");
    if (!b) return;
    const f = FORMATS[state.format];
    const key = `${f.fov}-${b.dataset.stereo}`;
    if (FORMATS[key]) { state.format = key; state.userPicked = true; state.refStereo = null; applyFormatUI(); recomputePlan(); }
  });
  el.standardSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-standard]");
    if (!b || b.disabled) return;
    state.standard = b.dataset.standard;
    applyFormatUI();
    recomputePlan();
    saveAdvanced();
  });
  el.smartApply.addEventListener("click", () => {
    if (!state.detection) return;
    state.format = state.detection.key;
    state.userPicked = true;
    applyFormatUI();
    recomputePlan();
    toast(`Switched to ${labelOf(state.format)}`, "ok", 2200);
  });
  el.smartWhy.addEventListener("click", () => { state.reasonsOpen = !state.reasonsOpen; renderSmart(); });

  // Advanced inputs.
  el.projInput.addEventListener("input", () => { state.proj = el.projInput.value; saveAdvanced(); recomputePlanSoon(); });
  el.headingInput.addEventListener("input", () => {
    const v = el.headingInput.value;
    const n = Number(v);
    const bad = v !== "" && (!Number.isFinite(n) || n < 0 || n > 360);
    el.headingInput.classList.toggle("invalid", bad);
    state.heading = bad ? "" : v;
    saveAdvanced();
    recomputePlanSoon();
  });
  el.cropToggle.addEventListener("change", () => {
    state.crop.enabled = el.cropToggle.checked;
    el.cropFields.hidden = !state.crop.enabled;
    validateCrop();
    saveAdvanced();
    recomputePlan();
  });
  $$("[data-crop]").forEach((i) => i.addEventListener("input", () => { state.crop[i.dataset.crop] = i.value; validateCrop(); saveAdvanced(); recomputePlanSoon(); }));
  $("#resetAdvBtn").addEventListener("click", () => {
    Object.assign(state, { standard: "both", proj: "", heading: "", refStereo: null, crop: { enabled: false, cW: "", cH: "", fW: "", fH: "", cL: "", cT: "" } });
    syncAdvancedInputs();
    saveAdvanced();
    applyFormatUI();
    recomputePlan();
    el.refStatus.className = "help";
    el.refStatus.textContent = "Match a known-good file exactly (all V1 values included).";
  });
  el.refBtn.addEventListener("click", () => el.refInput.click());
  el.refInput.addEventListener("change", () => { const f = el.refInput.files[0]; el.refInput.value = ""; if (f) applyReference(f); });

  // Save.
  el.saveBtn.addEventListener("click", save);
  $("#cancelBtn").addEventListener("click", () => { if (state.saving) state.saving.cancelled = true; });

  // Preview controls.
  $("#viewModeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b || b.disabled) return;
    state.viewMode = b.dataset.mode;
    syncViewer();
  });
  $("#eyeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-eye]");
    if (!b) return;
    state.eye = b.dataset.eye;
    syncViewer();
  });
  el.playBtn.addEventListener("click", () => {
    const v = el.video;
    if (!v.src) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  });
  el.video.addEventListener("play", () => setPlaying(true));
  el.video.addEventListener("pause", () => setPlaying(false));
  el.video.addEventListener("timeupdate", updateTime);
  el.video.addEventListener("loadedmetadata", () => { updateTime(); updateGuide(); });
  el.seek.addEventListener("input", () => {
    const v = el.video;
    if (Number.isFinite(v.duration)) v.currentTime = (Number(el.seek.value) / 1000) * v.duration;
    updateTime();
  });
  $("#resetViewBtn").addEventListener("click", () => viewer && viewer.reset());
  $("#fullscreenBtn").addEventListener("click", () => {
    const s = el.stage;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (s.requestFullscreen) s.requestFullscreen().catch(() => {});
  });
  new ResizeObserver(updateGuide).observe(el.stage);

  // Technical panel tabs + report export.
  $("#techTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    $$("#techTabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $$(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  });
  $("#copyJsonBtn").addEventListener("click", async () => {
    if (!state.analysis) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(reportObject(), null, 2));
      toast("Report copied to clipboard", "ok", 2000);
    } catch (_) {
      toast("Couldn't access the clipboard — use Download instead.", "bad");
    }
  });
  $("#downloadJsonBtn").addEventListener("click", () => {
    if (!state.analysis) return;
    const blob = new Blob([JSON.stringify(reportObject(), null, 2)], { type: "application/json" });
    download(blob, state.file.name.replace(/\.[^.]+$/, "") + "_3dmetafix_report.json");
  });

  // Theme.
  $("#themeBtn").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("3dmetafix.theme", root.dataset.theme); } catch (_) { /* ignore */ }
  });

  // ───────────────────────── init ─────────────────────────
  loadAdvanced();
  applyFormatUI();
  window.__metafix = { state, openFile }; // handy for debugging and automated tests
})();
