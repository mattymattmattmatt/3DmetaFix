/*!
 * 3DmetaFix engine — reads and writes spherical / stereo-3D metadata in MP4 & MOV.
 *
 * Works directly on the ISO-BMFF / QuickTime box tree. Only the `moov` header
 * (typically a few hundred KB) is ever loaded into memory; the media payload is
 * spliced through untouched, so nothing is re-encoded and multi-GB files are fine.
 *
 * Writes:
 *   - Spherical Video V1  — GSpherical RDF/XML in a `uuid` box inside each video `trak`
 *   - Spherical Video V2  — `st3d` + `sv3d` boxes inside each video sample entry
 * Reads, additionally:
 *   - Apple Projected Media / spatial video (`vexu`) and ambisonic audio (`SA3D`)
 *
 * When the header changes size the engine first tries to absorb the difference
 * in existing `free` padding (zero bytes move). Otherwise every absolute offset
 * that points past the header (stco, co64, saio, tfhd, tfra) is remapped, with
 * automatic stco → co64 promotion if a 32-bit offset would overflow.
 *
 * No dependencies. Browser: window.MetaFix. Node: require("./mp4.js").
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MetaFix = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const SOFTWARE = "3DmetaFix";
  const GS_UUID_HEX = "ffcc8263f8554a938814587a02521fdd";
  const GS_UUID = hexToBytes(GS_UUID_HEX);
  const TWO32 = 4294967296;
  const MAX_MOOV = 1024 * 1024 * 1024; // sanity cap for the in-memory header

  // Boxes whose payload is nothing but child boxes.
  const CONTAINERS = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "moof", "traf",
    "mfra", "udta", "tref", "sv3d", "proj", "sinf", "schi", "vexu", "eyes", "pack", "gmhd"
  ]);
  const FREE_TYPES = new Set(["free", "skip"]);

  /** The formats the UI offers. `fov` is 360, 180 or "flat". */
  const FORMATS = {
    "360-mono": { fov: 360, stereo: "mono", label: "360° 2D", short: "360° · 2D", suffix: "360" },
    "360-tb":   { fov: 360, stereo: "tb",   label: "360° 3D top-bottom", short: "360° · 3D TB", suffix: "360_3d_tb" },
    "360-sbs":  { fov: 360, stereo: "sbs",  label: "360° 3D side-by-side", short: "360° · 3D SBS", suffix: "360_3d_sbs" },
    "180-sbs":  { fov: 180, stereo: "sbs",  label: "VR180 3D side-by-side", short: "180° · 3D SBS", suffix: "vr180" },
    "180-tb":   { fov: 180, stereo: "tb",   label: "180° 3D top-bottom", short: "180° · 3D TB", suffix: "180_3d_tb" },
    "180-mono": { fov: 180, stereo: "mono", label: "180° 2D", short: "180° · 2D", suffix: "180" },
    "flat-sbs": { fov: "flat", stereo: "sbs", label: "3D side-by-side (flat screen)", short: "Flat · 3D SBS", suffix: "3d_sbs" },
    "flat-tb":  { fov: "flat", stereo: "tb",  label: "3D top-bottom (flat screen)", short: "Flat · 3D TB", suffix: "3d_tb" },
    "flat-mono":{ fov: "flat", stereo: "mono", label: "Regular 2D video", short: "Flat · 2D", suffix: "flat" }
  };

  const CODECS = {
    avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC", dvh1: "HEVC (Dolby Vision)", dvhe: "HEVC (Dolby Vision)",
    av01: "AV1", vp09: "VP9", vp08: "VP8", mp4v: "MPEG-4", apch: "ProRes 422 HQ", apcn: "ProRes 422",
    apcs: "ProRes 422 LT", apco: "ProRes 422 Proxy", ap4h: "ProRes 4444", ap4x: "ProRes 4444 XQ",
    jpeg: "Motion JPEG", mjpa: "Motion JPEG", encv: "Encrypted video",
    mp4a: "AAC", Opus: "Opus", "ac-3": "AC-3", "ec-3": "E-AC-3", fLaC: "FLAC", alac: "ALAC",
    lpcm: "PCM", sowt: "PCM", twos: "PCM", in24: "PCM", in32: "PCM", fl32: "PCM", ".mp3": "MP3", enca: "Encrypted audio"
  };

  class MetaFixError extends Error {
    constructor(code, message, hint) {
      super(message);
      this.name = "MetaFixError";
      this.code = code;
      this.hint = hint || "";
    }
  }

  // ───────────────────────────── byte helpers ─────────────────────────────

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(u8, start, end) {
    let s = "";
    for (let i = start; i < end; i++) s += u8[i].toString(16).padStart(2, "0");
    return s;
  }
  function fourcc(u8, o) {
    return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  }
  function isTypeByte(c) { return (c >= 0x20 && c <= 0x7e) || c === 0xa9; }
  function looksLikeType(u8, o) {
    return o + 4 <= u8.length && isTypeByte(u8[o]) && isTypeByte(u8[o + 1]) && isTypeByte(u8[o + 2]) && isTypeByte(u8[o + 3]);
  }
  function viewOf(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  function u64(dv, o) { return dv.getUint32(o) * TWO32 + dv.getUint32(o + 4); }
  function setU64(dv, o, v) { dv.setUint32(o, Math.floor(v / TWO32)); dv.setUint32(o + 4, v >>> 0); }
  const utf8 = (s) => new TextEncoder().encode(s);
  const fromUtf8 = (u8) => new TextDecoder("utf-8", { fatal: false }).decode(u8);

  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function u32b(v) { const b = new Uint8Array(4); viewOf(b).setUint32(0, v >>> 0); return b; }
  function i32b(v) { const b = new Uint8Array(4); viewOf(b).setInt32(0, v | 0); return b; }

  /** Build a plain box from payload parts. */
  function makeBox(type, ...payload) {
    const body = concat(payload);
    const out = new Uint8Array(8 + body.length);
    viewOf(out).setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  }
  /** Build a FullBox (version + 24-bit flags) from payload parts. */
  function makeFullBox(type, version, flags, ...payload) {
    return makeBox(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
  }
  function makeFree(size) {
    const out = new Uint8Array(size);
    viewOf(out).setUint32(0, size);
    out.set([0x66, 0x72, 0x65, 0x65], 4); // "free"
    return out;
  }

  // ───────────────────────────── box tree ─────────────────────────────

  function readHeader(dv, u8, off, limit) {
    if (off + 8 > limit) return null;
    let size = dv.getUint32(off);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > limit) return null;
      size = u64(dv, off + 8);
      hdr = 16;
    } else if (size === 0) {
      size = limit - off; // "extends to end of parent"
    }
    if (size < hdr || off + size > limit) return null;
    return { type: fourcc(u8, off + 4), size, hdr };
  }

  function findChildRange(u8, dv, from, to, type) {
    let off = from;
    while (off + 8 <= to) {
      const h = readHeader(dv, u8, off, to);
      if (!h) return null;
      if (h.type === type) return { cs: off + h.hdr, ce: off + h.size };
      off += h.size;
    }
    return null;
  }

  /** Read a trak's handler type (vide/soun/…) without building its subtree. */
  function peekHandler(u8, dv, from, to) {
    const mdia = findChildRange(u8, dv, from, to, "mdia");
    if (!mdia) return null;
    const hdlr = findChildRange(u8, dv, mdia.cs, mdia.ce, "hdlr");
    if (!hdlr || hdlr.cs + 12 > hdlr.ce) return null;
    return fourcc(u8, hdlr.cs + 8);
  }

  function parseChildren(u8, dv, parent, from, to, ctx) {
    const kids = [];
    let off = from;
    while (off + 8 <= to) {
      const h = readHeader(dv, u8, off, to);
      if (!h) break;
      const node = { type: h.type, start: off, end: off + h.size, hdr: h.hdr, pre: 0, children: null, tailStart: off + h.size, parent };
      expand(node, u8, dv, ctx);
      kids.push(node);
      off = node.end;
    }
    return { kids, stop: off };
  }

  function expand(n, u8, dv, ctx) {
    const t = n.type, cs = n.start + n.hdr, ce = n.end;
    let pre = -1, childCtx = ctx;
    if (t === "trak") {
      n.handler = peekHandler(u8, dv, cs, ce);
      childCtx = { handler: n.handler };
      pre = 0;
    } else if (CONTAINERS.has(t)) {
      pre = 0;
    } else if (t === "meta") {
      // ISO meta is a FullBox; QuickTime meta is a plain container.
      pre = (ce - cs >= 12 && dv.getUint32(cs) === 0 && looksLikeType(u8, cs + 8)) ? 4 : 0;
    } else if (t === "stsd") {
      pre = 8;
    } else if (n.parent && n.parent.type === "stsd") {
      if (ctx.handler === "vide") pre = 78; // VisualSampleEntry
      else if (ctx.handler === "soun") {
        const v = ce - cs >= 10 ? dv.getUint16(cs + 8) : 0;
        pre = v === 1 ? 44 : v === 2 ? 64 : 28; // QuickTime sound description v0/v1/v2
      }
    }
    if (pre < 0 || cs + pre > ce) return;
    n.pre = pre;
    const r = parseChildren(u8, dv, n, cs + pre, ce, childCtx);
    n.children = r.kids;
    n.tailStart = r.stop;
    n.partial = ce - r.stop >= 8; // ≥ 8 unparseable bytes: structure not fully understood
  }

  function parseTree(u8) {
    const root = { type: "#root", start: 0, end: u8.length, hdr: 0, pre: 0, children: [], tailStart: u8.length, parent: null };
    const r = parseChildren(u8, viewOf(u8), root, 0, u8.length, {});
    root.children = r.kids;
    return root;
  }

  const kid = (n, type) => (n && n.children ? n.children.find((c) => c.type === type) : null) || null;
  const kidsOf = (n, type) => (n && n.children ? n.children.filter((c) => c.type === type) : []);
  function walk(n, fn) {
    for (const c of n.children || []) { fn(c); walk(c, fn); }
  }
  function findAll(n, type) {
    const out = [];
    walk(n, (c) => { if (c.type === type) out.push(c); });
    return out;
  }
  const cstart = (n) => n.start + n.hdr;

  function touch(n) {
    while (n) { n.dirty = true; n = n.parent; }
  }
  function removeNode(n) {
    const p = n.parent;
    const i = p.children.indexOf(n);
    if (i >= 0) { p.children.splice(i, 1); touch(p); }
  }
  function appendNode(parent, type, bytes) {
    parent.children.push({ type, bytes, hdr: 8, parent });
    touch(parent);
  }
  function replaceNode(n, type, bytes) {
    const p = n.parent;
    const i = p.children.indexOf(n);
    const repl = { type, bytes, hdr: 8, parent: p };
    p.children[i] = repl;
    touch(p);
    return repl;
  }

  function measure(n) {
    if (n.bytes) return n.bytes.length;
    if (!n.dirty) return n.end - n.start;
    let s = n.hdr + n.pre + (n.end - n.tailStart);
    for (const c of n.children) s += measure(c);
    if (n.hdr === 8 && s > 0xffffffff) throw new MetaFixError("TOO_BIG", `The '${n.type}' box would exceed 4 GB.`);
    return s;
  }

  function writeNode(n, src, out, pos) {
    if (n.bytes) { out.set(n.bytes, pos); return pos + n.bytes.length; }
    if (!n.dirty) { out.set(src.subarray(n.start, n.end), pos); return pos + (n.end - n.start); }
    const size = measure(n);
    const dv = viewOf(out);
    if (n.hdr === 16) {
      dv.setUint32(pos, 1);
      setU64(dv, pos + 8, size);
    } else {
      dv.setUint32(pos, size);
    }
    for (let i = 0; i < 4; i++) out[pos + 4 + i] = n.type.charCodeAt(i);
    let p = pos + n.hdr;
    const cs = n.start + n.hdr;
    out.set(src.subarray(cs, cs + n.pre), p);
    p += n.pre;
    for (const c of n.children) p = writeNode(c, src, out, p);
    out.set(src.subarray(n.tailStart, n.end), p);
    return p + (n.end - n.tailStart);
  }

  function serialize(n, src) {
    const out = new Uint8Array(measure(n));
    writeNode(n, src, out, 0);
    return out;
  }

  // ───────────────────────────── blob reading ─────────────────────────────

  async function readRange(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  /** Small read-ahead window so headers of adjacent small boxes cost one read. */
  class WindowReader {
    constructor(blob, win) { this.blob = blob; this.win = win || 65536; this.buf = null; this.at = 0; }
    async read(off, len) {
      const b = this.buf;
      if (b && off >= this.at && off + len <= this.at + b.length) return b.subarray(off - this.at, off - this.at + len);
      const end = Math.min(this.blob.size, off + Math.max(len, this.win));
      this.buf = await readRange(this.blob, off, end);
      this.at = off;
      return this.buf.subarray(0, Math.min(len, this.buf.length));
    }
  }

  async function scanTopLevel(blob, reader) {
    const boxes = [];
    const size = blob.size;
    let off = 0, truncated = false, trailing = 0;
    while (off + 8 <= size) {
      const h = await reader.read(off, 16);
      const dv = viewOf(h);
      let bsize = dv.getUint32(0), hdr = 8;
      if (bsize === 1) {
        if (h.length < 16) break;
        bsize = u64(dv, 8);
        hdr = 16;
      } else if (bsize === 0) {
        bsize = size - off;
      }
      if (bsize < hdr || !looksLikeType(h, 4)) { trailing = size - off; break; }
      const box = { type: fourcc(h, 4), start: off, size: bsize, end: off + bsize, hdr };
      if (box.end > size) { truncated = true; box.declaredEnd = box.end; box.end = size; }
      boxes.push(box);
      off = box.end;
      if (boxes.length > 500000) throw new MetaFixError("MALFORMED", "This file has an implausible number of top-level boxes.");
    }
    if (!trailing && off < size) trailing = size - off;
    return { boxes, truncated, trailing };
  }

  // ───────────────────────────── metadata parsing ─────────────────────────────

  function unescapeXml(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === "lt") return "<";
      if (k === "gt") return ">";
      if (k === "amp") return "&";
      if (k === "quot") return '"';
      if (k === "apos") return "'";
      const code = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }

  function parseV1Xml(xml) {
    const tags = {};
    const re = /<GSpherical:([A-Za-z0-9_]+)\s*>([\s\S]*?)<\/GSpherical:\1\s*>/g;
    let m;
    while ((m = re.exec(xml)) !== null) tags[m[1]] = unescapeXml(m[2].trim());
    return tags;
  }

  /** Strict well-formedness check so we can flag broken XML written by other tools. */
  function xmlLooksWellFormed(xml) {
    if (!/<rdf:SphericalVideo\s+xmlns:/.test(xml)) return false;
    if (!/<\/rdf:SphericalVideo>\s*\u0000*\s*$/.test(xml)) return false;
    return true;
  }

  function parseSt3d(n, u8) {
    const cs = cstart(n);
    return cs + 5 <= n.end ? u8[cs + 4] : null;
  }

  function parseSv3d(n, u8, dv) {
    const out = { source: "", projection: null, pose: null, bounds: null, layout: null };
    const svhd = kid(n, "svhd");
    if (svhd) {
      const cs = cstart(svhd) + 4;
      let e = cs;
      while (e < svhd.end && u8[e] !== 0) e++;
      out.source = fromUtf8(u8.subarray(cs, e));
    }
    const proj = kid(n, "proj");
    if (proj) {
      const prhd = kid(proj, "prhd");
      if (prhd && cstart(prhd) + 16 <= prhd.end) {
        const cs = cstart(prhd);
        out.pose = { yaw: dv.getInt32(cs + 4) / 65536, pitch: dv.getInt32(cs + 8) / 65536, roll: dv.getInt32(cs + 12) / 65536 };
      }
      const equi = kid(proj, "equi");
      const cbmp = kid(proj, "cbmp");
      const mesh = kid(proj, "mshp") || kid(proj, "ytmp");
      if (equi && cstart(equi) + 20 <= equi.end) {
        const cs = cstart(equi);
        out.projection = "equirectangular";
        out.bounds = {
          top: dv.getUint32(cs + 4) / TWO32, bottom: dv.getUint32(cs + 8) / TWO32,
          left: dv.getUint32(cs + 12) / TWO32, right: dv.getUint32(cs + 16) / TWO32
        };
      } else if (cbmp) {
        out.projection = "cubemap";
        const cs = cstart(cbmp);
        if (cs + 12 <= cbmp.end) out.layout = dv.getUint32(cs + 4);
      } else if (mesh) {
        out.projection = "mesh";
      }
    }
    return out;
  }

  function parseSa3d(n, u8, dv) {
    const cs = cstart(n);
    if (cs + 12 > n.end) return { present: true };
    return {
      present: true,
      type: u8[cs + 1],
      order: dv.getUint32(cs + 2),
      ordering: u8[cs + 6] === 0 ? "ACN" : String(u8[cs + 6]),
      normalization: u8[cs + 7] === 0 ? "SN3D" : String(u8[cs + 7]),
      channels: dv.getUint32(cs + 8)
    };
  }

  /** Apple vexu: scan for the few leaf boxes we care about (structure varies by OS release). */
  function parseVexu(n, u8) {
    const find = (tag) => {
      const a = tag.charCodeAt(0), b = tag.charCodeAt(1), c = tag.charCodeAt(2), d = tag.charCodeAt(3);
      for (let i = n.start + 8; i + 4 <= n.end; i++) {
        if (u8[i] === a && u8[i + 1] === b && u8[i + 2] === c && u8[i + 3] === d) return i;
      }
      return -1;
    };
    const prji = find("prji");
    const pkin = find("pkin");
    return {
      projectionKind: prji >= 0 && prji + 12 <= n.end ? fourcc(u8, prji + 8) : null,
      packing: pkin >= 0 && pkin + 12 <= n.end ? fourcc(u8, pkin + 8) : null,
      stereoEyes: find("stri") >= 0
    };
  }

  // ───────────────────────────── interpretation ─────────────────────────────

  const STEREO_V2 = { 0: "mono", 1: "tb", 2: "sbs", 3: "custom", 4: "sbs" };
  const STEREO_V2_CODE = { mono: 0, tb: 1, sbs: 2 };
  const STEREO_V1 = { sbs: "left-right", tb: "top-bottom" };

  function fovBucket(fov) {
    if (fov === "flat" || fov == null) return fov;
    if (fov >= 300) return 360;
    if (fov >= 150 && fov <= 220) return 180;
    return Math.round(fov);
  }

  function keyFor(fov, stereo) {
    const k = `${fovBucket(fov)}-${stereo}`;
    return FORMATS[k] ? k : null;
  }

  function interpretV1(tags) {
    const pt = String(tags.ProjectionType || "").trim().toLowerCase();
    const sm = String(tags.StereoMode || "").trim().toLowerCase();
    const stereo = sm === "left-right" ? "sbs" : sm === "top-bottom" ? "tb" : (!sm || sm === "mono") ? "mono" : "custom";
    let fov = null, projection = pt || null;
    const cw = Number(tags.CroppedAreaImageWidthPixels), fw = Number(tags.FullPanoWidthPixels);
    if (pt.includes("equirect")) {
      projection = "equirectangular";
      if (pt.includes("half")) fov = 180;
      else if (cw > 0 && fw > 0) fov = 360 * Math.min(1, cw / fw);
      else fov = 360;
    } else if (pt === "cubemap") {
      fov = 360;
    }
    return { fov, projection, stereo, key: keyFor(fov, stereo), spherical: String(tags.Spherical || "").toLowerCase() === "true" };
  }

  function interpretV2(st3d, sv3d) {
    const stereo = st3d == null ? "mono" : (STEREO_V2[st3d] || "custom");
    if (!sv3d) {
      if (st3d == null) return null;
      return { fov: "flat", projection: null, stereo, key: keyFor("flat", stereo), rightLeft: st3d === 4 };
    }
    let fov = null;
    if (sv3d.projection === "equirectangular" && sv3d.bounds) {
      fov = 360 * Math.max(0, 1 - sv3d.bounds.left - sv3d.bounds.right);
    } else if (sv3d.projection === "cubemap") {
      fov = 360;
    }
    return { fov, projection: sv3d.projection, stereo, key: keyFor(fov, stereo), rightLeft: st3d === 4 };
  }

  function interpretApple(vexu) {
    if (!vexu) return null;
    const kinds = { equi: 360, hequ: 180 };
    const fov = vexu.projectionKind ? (kinds[vexu.projectionKind] || null) : "flat";
    const stereo = vexu.packing === "side" ? "sbs" : vexu.packing === "over" ? "tb" : vexu.stereoEyes ? "multiview" : "mono";
    let label = "Apple spatial video (MV-HEVC)";
    if (vexu.projectionKind === "fish") label = "Apple Immersive / fisheye";
    else if (vexu.projectionKind === "prim") label = "Apple parametric immersive (wide FOV)";
    else if (fov === 360 || fov === 180) label = `Apple Projected Media (${fov}°)`;
    return { fov, stereo, projection: vexu.projectionKind, key: keyFor(fov, stereo), label };
  }

  function sameMeaning(a, b) {
    if (!a || !b) return true;
    return fovBucket(a.fov) === fovBucket(b.fov) && a.stereo === b.stereo;
  }

  // ───────────────────────────── analysis ─────────────────────────────

  function analyzeTrack(trak, u8, dv, index) {
    const t = {
      index, id: null, handler: trak.handler || null, codec: null, codecName: null, entryCount: 0,
      width: 0, height: 0, timescale: 0, duration: 0, sampleCount: 0, chunkCount: 0,
      v1: null, v2: null, apple: null, spatialAudio: null, writable: true, problems: []
    };
    const tkhd = kid(trak, "tkhd");
    if (tkhd) {
      const cs = cstart(tkhd);
      const v = u8[cs];
      if (cs + (v === 1 ? 24 : 16) <= tkhd.end) t.id = dv.getUint32(cs + (v === 1 ? 20 : 12));
    }
    const mdia = kid(trak, "mdia");
    const mdhd = kid(mdia, "mdhd");
    if (mdhd) {
      const cs = cstart(mdhd);
      const v = u8[cs];
      if (v === 1 && cs + 32 <= mdhd.end) { t.timescale = dv.getUint32(cs + 20); t.duration = u64(dv, cs + 24); }
      else if (cs + 20 <= mdhd.end) { t.timescale = dv.getUint32(cs + 12); t.duration = dv.getUint32(cs + 16); }
    }
    const minf = kid(mdia, "minf");
    const stbl = kid(minf, "stbl");
    const stsd = kid(stbl, "stsd");
    const chain = [trak, mdia, minf, stbl, stsd];
    if (chain.some((n) => !n || !n.children || n.partial)) {
      t.writable = false;
      t.problems.push("sample table structure could not be fully parsed");
    }
    const entries = stsd && stsd.children ? stsd.children : [];
    t.entryCount = entries.length;
    const first = entries[0];
    if (first) {
      t.codec = first.type;
      t.codecName = CODECS[first.type] || first.type.trim();
      const cs = cstart(first);
      if (t.handler === "vide" && cs + 28 <= first.end) {
        t.width = dv.getUint16(cs + 24);
        t.height = dv.getUint16(cs + 26);
      }
    }
    if (t.handler === "vide") {
      for (const e of entries) {
        if (!e.children || e.partial) { t.writable = false; t.problems.push(`sample entry '${e.type}' could not be parsed`); continue; }
        const st3d = kid(e, "st3d");
        const sv3d = kid(e, "sv3d");
        const vexu = kid(e, "vexu");
        if ((st3d || sv3d) && !t.v2) {
          const sv = sv3d ? parseSv3d(sv3d, u8, dv) : null;
          const mode = st3d ? parseSt3d(st3d, u8) : null;
          t.v2 = { st3d: mode, sv3d: sv, meaning: interpretV2(mode, sv) };
        }
        if (vexu && !t.apple) {
          const vx = parseVexu(vexu, u8);
          t.apple = Object.assign(vx, { meaning: interpretApple(vx) });
        }
      }
    }
    if (t.handler === "soun") {
      for (const e of entries) {
        const sa3d = kid(e, "SA3D");
        if (sa3d) { t.spatialAudio = parseSa3d(sa3d, u8, dv); break; }
      }
    }
    const stsz = kid(stbl, "stsz") || kid(stbl, "stz2");
    if (stsz && cstart(stsz) + 12 <= stsz.end) t.sampleCount = dv.getUint32(cstart(stsz) + 8);
    const co = kid(stbl, "stco") || kid(stbl, "co64");
    if (co && cstart(co) + 8 <= co.end) {
      t.chunkCount = dv.getUint32(cstart(co) + 4);
      t._chunks = { type: co.type, start: co.start, end: co.end, hdr: co.hdr };
    }
    return t;
  }

  function findV1(trak, u8) {
    for (const c of trak.children || []) {
      if (c.type !== "uuid") continue;
      const cs = cstart(c);
      if (cs + 16 > c.end || bytesToHex(u8, cs, cs + 16) !== GS_UUID_HEX) continue;
      const xml = fromUtf8(u8.subarray(cs + 16, c.end));
      const tags = parseV1Xml(xml);
      return { xml, tags, wellFormed: xmlLooksWellFormed(xml), meaning: interpretV1(tags), location: "trak" };
    }
    return null;
  }

  function fragmentDataPos(bytes, boxStart) {
    try {
      const tree = parseTree(bytes);
      const moof = kid(tree, "moof");
      const traf = kid(moof, "traf");
      const tfhd = kid(traf, "tfhd");
      if (!tfhd) return null;
      const dv = viewOf(bytes);
      const cs = cstart(tfhd);
      const flags = (bytes[cs + 1] << 16) | (bytes[cs + 2] << 8) | bytes[cs + 3];
      let base = flags & 1 ? u64(dv, cs + 8) : boxStart;
      const trun = kid(traf, "trun");
      if (trun) {
        const tcs = cstart(trun);
        const tflags = (bytes[tcs + 1] << 16) | (bytes[tcs + 2] << 8) | bytes[tcs + 3];
        if (tflags & 1) base += dv.getInt32(tcs + 8);
      }
      return base;
    } catch (_) {
      return null;
    }
  }

  /**
   * Inspect a file (Blob/File). Reads the box layout and the moov header only.
   * Returns a plain report plus a private `_raw` with what the writer needs.
   */
  async function analyze(blob, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const name = opts.name || blob.name || "video.mp4";
    const reader = new WindowReader(blob);
    const scan = await scanTopLevel(blob, reader);
    const top = scan.boxes;
    const warnings = [];

    if (!top.length) {
      throw new MetaFixError("NOT_MP4", "This doesn't look like an MP4 or MOV file.", "Choose a .mp4 or .mov video.");
    }
    const ftyp = top.find((b) => b.type === "ftyp");
    let brand = null;
    const compatible = [];
    if (ftyp) {
      const fb = await reader.read(ftyp.start, Math.min(ftyp.size, 128));
      if (fb.length >= ftyp.hdr + 4) brand = fourcc(fb, ftyp.hdr);
      for (let o = ftyp.hdr + 8; o + 4 <= fb.length; o += 4) compatible.push(fourcc(fb, o));
    }
    const moovs = top.filter((b) => b.type === "moov");
    if (!moovs.length) {
      const hasMdat = top.some((b) => b.type === "mdat");
      throw new MetaFixError(
        "NO_MOOV",
        hasMdat ? "This file has video data but no 'moov' header — the recording was probably interrupted."
                : "This file has no 'moov' header, so it isn't a playable MP4/MOV.",
        hasMdat ? "Recover the clip with a repair tool first, then fix its metadata here." : ""
      );
    }
    if (moovs.length > 1) warnings.push("File contains more than one 'moov' box; using the first.");
    const mb = moovs[0];
    if (mb.declaredEnd) throw new MetaFixError("TRUNCATED", "The file ends in the middle of its 'moov' header — it is truncated.");
    if (mb.size > MAX_MOOV) throw new MetaFixError("TOO_BIG", "The 'moov' header is unrealistically large.");
    if (scan.truncated) warnings.push("The file appears truncated: the last box is shorter than declared.");

    const moovU8 = await readRange(blob, mb.start, mb.end);
    const dv = viewOf(moovU8);
    const tree = parseTree(moovU8);
    const moov = tree.children[0];
    if (!moov || moov.type !== "moov" || !moov.children) throw new MetaFixError("MALFORMED", "The 'moov' header could not be parsed.");
    if (kid(moov, "cmov")) throw new MetaFixError("UNSUPPORTED", "This QuickTime file uses a compressed movie header (cmov), which isn't supported.");

    const traks = kidsOf(moov, "trak");
    const tracks = traks.map((tr, i) => {
      const t = analyzeTrack(tr, moovU8, dv, i);
      t.v1 = findV1(tr, moovU8);
      return t;
    });

    // Some tools put the V1 uuid in the wrong place (moov or udta). Report it so it can be cleaned up.
    let strayV1 = null;
    walk(moov, (c) => {
      if (c.type !== "uuid" || (c.parent && c.parent.type === "trak")) return;
      const cs = cstart(c);
      if (cs + 16 <= c.end && bytesToHex(moovU8, cs, cs + 16) === GS_UUID_HEX && !strayV1) {
        const xml = fromUtf8(moovU8.subarray(cs + 16, c.end));
        const tags = parseV1Xml(xml);
        strayV1 = { xml, tags, wellFormed: xmlLooksWellFormed(xml), meaning: interpretV1(tags), location: c.parent ? c.parent.type : "moov" };
      }
    });

    const mvhd = kid(moov, "mvhd");
    let duration = 0;
    if (mvhd) {
      const cs = cstart(mvhd);
      const v = moovU8[cs];
      if (v === 1 && cs + 32 <= mvhd.end) duration = u64(dv, cs + 24) / (dv.getUint32(cs + 20) || 1);
      else if (cs + 20 <= mvhd.end) duration = dv.getUint32(cs + 16) / (dv.getUint32(cs + 12) || 1);
    }

    const fragmented = !!kid(moov, "mvex");
    const fragments = [];
    if (fragmented) {
      for (const b of top) {
        if ((b.type === "moof" || b.type === "mfra") && b.start >= mb.end && b.size < 64 * 1024 * 1024) {
          const bytes = await readRange(blob, b.start, b.end);
          fragments.push({ type: b.type, start: b.start, end: b.end, bytes, dataPos: b.type === "moof" ? fragmentDataPos(bytes, b.start) : null });
        }
      }
    }

    const video = tracks.find((t) => t.handler === "vide") || null;
    if (!video) warnings.push("No video track was found.");
    const audio = tracks.find((t) => t.handler === "soun") || null;
    const mdatFirst = top.find((b) => b.type === "mdat");
    const v1 = (video && video.v1) || strayV1;
    const v2 = video && video.v2;
    const apple = video && video.apple;

    const meta = {
      v1: v1 || null,
      v2: v2 || null,
      apple: apple || null,
      spatialAudio: tracks.map((t) => t.spatialAudio).find(Boolean) || null,
      effective: null,
      conflicts: []
    };
    // What players will most likely use: V2 wins over V1; Apple's own tags win on Apple devices.
    const effective = (v2 && v2.meaning) || (v1 && v1.meaning && v1.meaning.spherical !== false && v1.meaning) || (apple && apple.meaning) || null;
    meta.effective = effective ? Object.assign({ source: effective === (v2 && v2.meaning) ? "v2" : effective === (v1 && v1.meaning) ? "v1" : "apple" }, effective) : null;
    if (v1 && v2 && !sameMeaning(v1.meaning, v2.meaning)) meta.conflicts.push("V1 (XML) and V2 (st3d/sv3d) metadata describe different formats.");
    if (apple && apple.meaning && (v1 || v2) && !sameMeaning(apple.meaning, (v2 || v1).meaning) && apple.meaning.fov !== "flat") {
      meta.conflicts.push("Apple (vexu) metadata disagrees with the spherical metadata.");
    }
    if (v1 && !v1.wellFormed) warnings.push("The existing V1 XML is malformed; strict players (e.g. YouTube) may ignore it.");
    if (strayV1 && !(video && video.v1)) warnings.push(`V1 metadata sits in '${strayV1.location}' instead of the video track; many players won't find it.`);
    if (video && v2 && v2.meaning && v2.meaning.rightLeft) warnings.push("Stereo layout is right-left (right eye first).");

    return {
      name,
      size: blob.size,
      brand,
      compatible,
      container: brand === "qt  " ? "mov" : "mp4",
      duration,
      fragmented,
      faststart: !!(mdatFirst && mb.start < mdatFirst.start),
      topLevel: top.map((b) => ({ type: b.type, start: b.start, size: b.size })),
      tracks: tracks.map(({ _chunks, ...rest }) => rest),
      video: video ? Object.assign({}, video, { _chunks: undefined }) : null,
      audio: audio ? { codec: audio.codec, codecName: audio.codecName } : null,
      meta,
      writable: !!video && tracks.filter((t) => t.handler === "vide").every((t) => t.writable) && !moov.partial,
      warnings,
      elapsedMs: Date.now() - t0,
      _raw: { moovU8, moovBox: mb, top, fragments, chunkTables: tracks.map((t) => t._chunks || null) }
    };
  }

  // ───────────────────────────── writing ─────────────────────────────

  function xmlEscape(s) {
    return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
  }

  const CROP_KEYS = [
    ["CroppedAreaImageWidthPixels", "cW"], ["CroppedAreaImageHeightPixels", "cH"],
    ["FullPanoWidthPixels", "fW"], ["FullPanoHeightPixels", "fH"],
    ["CroppedAreaLeftPixels", "cL"], ["CroppedAreaTopPixels", "cT"]
  ];

  /** GSpherical XML, byte-compatible with Google's Spatial Media Metadata Injector layout. */
  function buildV1Xml(v1, padding) {
    const tag = (k, v) => `<GSpherical:${k}>${xmlEscape(v)}</GSpherical:${k}>`;
    let x = '<?xml version="1.0"?><rdf:SphericalVideo\n' +
      'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n' +
      'xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">';
    x += tag("Spherical", "true") + tag("Stitched", "true") + tag("StitchingSoftware", v1.software || SOFTWARE);
    x += tag("ProjectionType", v1.projectionType);
    if (v1.stereoMode) x += tag("StereoMode", v1.stereoMode);
    if (v1.heading != null && v1.heading !== "" && Number.isFinite(Number(v1.heading))) x += tag("InitialViewHeadingDegrees", Math.round(Number(v1.heading)));
    if (v1.crop) for (const [k, short] of CROP_KEYS) x += tag(k, Math.round(Number(v1.crop[short]) || 0));
    if (padding > 0) x += " ".repeat(padding); // insignificant whitespace, used to keep header size stable
    return x + "</rdf:SphericalVideo>";
  }

  function buildUuidBox(xml) {
    return makeBox("uuid", GS_UUID, utf8(xml));
  }

  function buildSt3d(mode) {
    return makeFullBox("st3d", 0, 0, Uint8Array.of(mode));
  }

  function buildSv3d(projection, software) {
    const svhd = makeFullBox("svhd", 0, 0, utf8((software || SOFTWARE) + "\0"));
    const prhd = makeFullBox("prhd", 0, 0, i32b(0), i32b(0), i32b(0));
    let pd;
    if (projection.kind === "cbmp") {
      pd = makeFullBox("cbmp", 0, 0, u32b(0), u32b(0));
    } else {
      const fx = (f) => Math.min(0xffffffff, Math.max(0, Math.round((f || 0) * TWO32)));
      const b = projection.bounds || {};
      pd = makeFullBox("equi", 0, 0, u32b(fx(b.top)), u32b(fx(b.bottom)), u32b(fx(b.left)), u32b(fx(b.right)));
    }
    return makeBox("sv3d", svhd, makeBox("proj", prhd, pd));
  }

  /**
   * Turn user-facing choices into a write spec.
   *   format:   key of FORMATS
   *   standard: "both" (V1 + V2, default) | "v1" | "v2"
   *   v1:       optional overrides { projectionType, stereoMode, heading, crop }
   */
  function buildSpec(options) {
    const o = options || {};
    const f = FORMATS[o.format];
    if (!f) throw new MetaFixError("BAD_FORMAT", `Unknown format '${o.format}'.`);
    const standard = o.standard || "both";
    const ov = o.v1 || {};
    const notes = [];
    const spec = { format: o.format, v1: null, v2: null, notes };

    if (f.fov === "flat") {
      if (f.stereo !== "mono") {
        spec.v2 = { stereo: STEREO_V2_CODE[f.stereo], projection: null };
        if (standard === "v1") notes.push("Flat 3D can only be described with V2 (st3d); V2 was used.");
      }
      return spec;
    }

    const defaultProjection = f.fov === 180 ? "half_equirectangular" : "equirectangular";
    const projectionType = String(ov.projectionType || defaultProjection).trim() || defaultProjection;
    const stereoMode = ov.stereoMode != null ? String(ov.stereoMode).trim() : (STEREO_V1[f.stereo] || "");
    if (standard !== "v2") {
      spec.v1 = { projectionType, stereoMode: stereoMode || null, heading: ov.heading, crop: ov.crop || null };
    }
    if (standard !== "v1") {
      const pt = projectionType.toLowerCase();
      let projection = null;
      if (pt === "cubemap") projection = { kind: "cbmp" };
      else if (pt.includes("equirect")) {
        projection = { kind: "equi", bounds: f.fov === 180 ? { top: 0, bottom: 0, left: 0.25, right: 0.25 } : { top: 0, bottom: 0, left: 0, right: 0 } };
      }
      if (projection) {
        spec.v2 = { stereo: f.stereo === "mono" ? null : STEREO_V2_CODE[f.stereo], projection };
      } else {
        notes.push(`V2 has no equivalent for projection '${projectionType}', so only V1 was written.`);
      }
    }
    return spec;
  }

  function isGsUuid(n, src) {
    if (n.type !== "uuid" || n.bytes) return false;
    const cs = cstart(n);
    return cs + 16 <= n.end && bytesToHex(src, cs, cs + 16) === GS_UUID_HEX;
  }

  function chunkTableOverflows(n, src, delta, threshold) {
    if (n.type !== "stco" || n.bytes) return false;
    const dv = viewOf(src);
    const cs = cstart(n);
    const count = dv.getUint32(cs + 4);
    const max = Math.min(count, Math.floor((n.end - cs - 8) / 4));
    for (let i = 0, p = cs + 8; i < max; i++, p += 4) {
      const v = dv.getUint32(p);
      if (v >= threshold && v + delta > 0xffffffff) return true;
    }
    return false;
  }

  function upgradeToCo64(n, src) {
    const dv = viewOf(src);
    const cs = cstart(n);
    const count = Math.min(dv.getUint32(cs + 4), Math.floor((n.end - cs - 8) / 4));
    const out = new Uint8Array(16 + count * 8);
    const ov = viewOf(out);
    ov.setUint32(0, out.length);
    out.set([0x63, 0x6f, 0x36, 0x34], 4); // "co64"
    ov.setUint32(8, dv.getUint32(cs));
    ov.setUint32(12, count);
    for (let i = 0; i < count; i++) setU64(ov, 16 + i * 8, dv.getUint32(cs + 8 + i * 4));
    return replaceNode(n, "co64", out);
  }

  /** Shift every absolute offset ≥ threshold by delta inside one table box. Returns entries changed. */
  function patchOffsetTable(n, src, delta, threshold) {
    const bytes = n.bytes ? n.bytes : src.slice(n.start, n.end);
    const hdr = n.bytes ? 8 : n.hdr;
    const dv = viewOf(bytes);
    let changed = 0;
    if (n.type === "stco" || n.type === "co64") {
      const wide = n.type === "co64";
      const count = Math.min(dv.getUint32(hdr + 4), Math.floor((bytes.length - hdr - 8) / (wide ? 8 : 4)));
      for (let i = 0, p = hdr + 8; i < count; i++, p += wide ? 8 : 4) {
        const v = wide ? u64(dv, p) : dv.getUint32(p);
        if (v < threshold) continue;
        if (wide) setU64(dv, p, v + delta); else dv.setUint32(p, v + delta);
        changed++;
      }
    } else if (n.type === "saio") {
      const version = bytes[hdr];
      const flags = (bytes[hdr + 1] << 16) | (bytes[hdr + 2] << 8) | bytes[hdr + 3];
      let p = hdr + 4 + (flags & 1 ? 8 : 0);
      const count = dv.getUint32(p);
      p += 4;
      for (let i = 0; i < count && p + (version ? 8 : 4) <= bytes.length; i++, p += version ? 8 : 4) {
        const v = version ? u64(dv, p) : dv.getUint32(p);
        if (v < threshold) continue;
        if (!version && v + delta > 0xffffffff) throw new MetaFixError("OVERFLOW", "An encryption offset table would overflow 32 bits.");
        if (version) setU64(dv, p, v + delta); else dv.setUint32(p, v + delta);
        changed++;
      }
    }
    if (changed) {
      n.bytes = bytes;
      n.hdr = hdr;
      touch(n.parent);
    }
    return changed;
  }

  function patchFragment(frag, delta, threshold) {
    const bytes = frag.bytes.slice();
    const dv = viewOf(bytes);
    const tree = parseTree(bytes);
    let changed = 0;
    if (frag.type === "moof") {
      for (const traf of kidsOf(kid(tree, "moof"), "traf")) {
        const tfhd = kid(traf, "tfhd");
        if (!tfhd) continue;
        const cs = cstart(tfhd);
        const flags = (bytes[cs + 1] << 16) | (bytes[cs + 2] << 8) | bytes[cs + 3];
        if (!(flags & 1) || cs + 16 > tfhd.end) continue;
        const v = u64(dv, cs + 8);
        if (v >= threshold) { setU64(dv, cs + 8, v + delta); changed++; }
      }
    } else {
      for (const tfra of kidsOf(kid(tree, "mfra"), "tfra")) {
        const cs = cstart(tfra);
        const version = bytes[cs];
        const sizes = dv.getUint32(cs + 8);
        const extra = ((sizes >> 4) & 3) + 1 + ((sizes >> 2) & 3) + 1 + (sizes & 3) + 1;
        const count = dv.getUint32(cs + 12);
        let p = cs + 16;
        for (let i = 0; i < count && p + (version ? 16 : 8) <= tfra.end; i++) {
          const op = p + (version ? 8 : 4);
          const v = version ? u64(dv, op) : dv.getUint32(op);
          if (v >= threshold) {
            if (version) setU64(dv, op, v + delta);
            else if (v + delta > 0xffffffff) throw new MetaFixError("OVERFLOW", "Fragment index offset would overflow 32 bits.");
            else dv.setUint32(op, v + delta);
            changed++;
          }
          p += (version ? 16 : 8) + extra;
        }
      }
    }
    return { bytes, changed };
  }

  /**
   * Compute exactly how to rewrite the file. Pure and synchronous: the result
   * can be built into a Blob immediately (e.g. inside a click handler).
   */
  function plan(analysis, spec) {
    if (!analysis.writable) {
      throw new MetaFixError("UNSUPPORTED", "This file's track structure couldn't be fully parsed, so it can't be safely modified.");
    }
    const { moovU8: src, moovBox, top, fragments } = analysis._raw;
    const tree = parseTree(src);
    const moov = tree.children[0];
    const videoTraks = kidsOf(moov, "trak").filter((t) => t.handler === "vide");
    const notes = spec.notes ? spec.notes.slice() : [];
    const result = { removed: { v1: 0, v2: 0 }, added: { v1: 0, v2: 0 } };

    // 1. Remove existing spherical metadata everywhere so the result is unambiguous.
    const strays = [];
    walk(moov, (c) => { if (isGsUuid(c, src)) strays.push(c); });
    for (const s of strays) { removeNode(s); result.removed.v1++; }
    const entries = [];
    for (const trak of videoTraks) {
      const stsd = kid(kid(kid(kid(trak, "mdia"), "minf"), "stbl"), "stsd");
      for (const e of stsd.children) {
        entries.push(e);
        for (const c of e.children.slice()) {
          if (c.type === "st3d" || c.type === "sv3d") { removeNode(c); result.removed.v2++; }
        }
      }
    }

    // 2. Add the new metadata.
    let xmlPad = 0;
    const v1Boxes = [];
    const addV1 = () => {
      videoTraks.forEach((trak, i) => {
        const box = buildUuidBox(buildV1Xml(spec.v1, i === 0 ? xmlPad : 0)); // pad once, not per track
        const existing = v1Boxes.find((b) => b.parent === trak);
        if (existing) { existing.bytes = box; touch(trak); }
        else { appendNode(trak, "uuid", box); v1Boxes.push(trak.children[trak.children.length - 1]); }
      });
    };
    if (spec.v1) { addV1(); result.added.v1 = videoTraks.length; }
    if (spec.v2) {
      const st3d = spec.v2.stereo != null ? buildSt3d(spec.v2.stereo) : null;
      const sv3d = spec.v2.projection ? buildSv3d(spec.v2.projection) : null;
      for (const e of entries) {
        if (st3d) appendNode(e, "st3d", st3d);
        if (sv3d) appendNode(e, "sv3d", sv3d);
        result.added.v2++;
      }
    }

    // 3. Keep the header the same size if we can, so no media byte moves.
    const oldSize = moovBox.size;
    let delta = measure(moov) - oldSize;
    let strategy = delta === 0 ? "same-size" : null;
    const splices = [];
    const frees = kidsOf(moov, "free").concat(kidsOf(moov, "skip")).filter((f) => !f.bytes);

    if (delta > 0 && frees.length) {
      const f = frees.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
      const s = f.end - f.start;
      if (s === delta) { removeNode(f); delta = 0; strategy = "padding"; }
      else if (s - delta >= 8) { replaceNode(f, "free", makeFree(s - delta)); delta = 0; strategy = "padding"; }
    } else if (delta < 0) {
      if (frees.length) { const f = frees[0]; replaceNode(f, "free", makeFree((f.end - f.start) - delta)); delta = 0; strategy = "padding"; }
      else if (-delta >= 8) { appendNode(moov, "free", makeFree(-delta)); delta = 0; strategy = "padding"; }
      else if (spec.v1) { xmlPad = -delta; addV1(); delta = measure(moov) - oldSize; strategy = "padding"; }
    }

    // Adjacent top-level free box (before or after moov) can also absorb the change.
    const ti = top.findIndex((b) => b.start === moovBox.start);
    if (delta !== 0) {
      for (const nb of [top[ti + 1], top[ti - 1]]) {
        if (!nb || !FREE_TYPES.has(nb.type) || nb.hdr !== 8) continue;
        const s = nb.size;
        if (s === delta) { splices.push({ start: nb.start, end: nb.start + s, bytes: new Uint8Array(0) }); delta = 0; }
        else if (s - delta >= 8) { splices.push({ start: nb.start, end: nb.start + s, bytes: makeFree(s - delta) }); delta = 0; }
        if (delta === 0) { strategy = "padding"; break; }
      }
    }

    // 4. Otherwise shift everything after the header and remap absolute offsets.
    let remapped = 0, promoted = 0;
    const threshold = moovBox.start + moovBox.size;
    if (delta !== 0) {
      for (;;) {
        const over = findAll(moov, "stco").filter((n) => chunkTableOverflows(n, src, delta, threshold));
        if (!over.length) break;
        for (const n of over) { upgradeToCo64(n, src); promoted++; }
        delta = measure(moov) - oldSize;
      }
      for (const type of ["stco", "co64"]) for (const n of findAll(moov, type)) remapped += patchOffsetTable(n, src, delta, threshold);
      for (const n of findAll(moov, "saio")) if (n.parent && n.parent.type === "stbl") remapped += patchOffsetTable(n, src, delta, threshold);
      for (const frag of fragments) {
        if (frag.start < threshold) continue;
        const r = patchFragment(frag, delta, threshold);
        if (r.changed) { splices.push({ start: frag.start, end: frag.end, bytes: r.bytes }); remapped += r.changed; }
      }
      strategy = remapped ? "remap" : "tail";
      if (promoted) notes.push(`${promoted} chunk table${promoted > 1 ? "s were" : " was"} promoted to 64-bit (co64) to stay valid past 4 GB.`);
    }

    const newMoov = serialize(moov, src);
    splices.push({ start: moovBox.start, end: moovBox.end, bytes: newMoov });
    splices.sort((a, b) => a.start - b.start);
    const outputSize = analysis.size + splices.reduce((s, x) => s + x.bytes.length - (x.end - x.start), 0);

    return {
      spec,
      splices,
      strategy, // same-size | padding | tail | remap
      delta,
      headerDelta: newMoov.length - oldSize,
      remapped,
      outputSize,
      notes,
      removed: result.removed,
      added: result.added,
      videoTracks: videoTraks.length
    };
  }

  /** Assemble the output as a lazy Blob: untouched ranges are slices of the original file. */
  function buildBlob(file, p, type) {
    const parts = [];
    let pos = 0;
    for (const s of p.splices) {
      if (s.start > pos) parts.push(file.slice(pos, s.start));
      if (s.bytes.length) parts.push(s.bytes);
      pos = s.end;
    }
    if (pos < file.size) parts.push(file.slice(pos, file.size));
    return new Blob(parts, { type: type || "video/mp4" });
  }

  function readChunkOffsets(analysis, trackIndex) {
    const t = analysis._raw.chunkTables[trackIndex];
    if (!t) return [];
    const u8 = analysis._raw.moovU8;
    const dv = viewOf(u8);
    const cs = t.start + t.hdr;
    const wide = t.type === "co64";
    const count = Math.min(dv.getUint32(cs + 4), Math.floor((t.end - cs - 8) / (wide ? 8 : 4)));
    const out = new Array(count);
    for (let i = 0, p = cs + 8; i < count; i++, p += wide ? 8 : 4) out[i] = wide ? u64(dv, p) : dv.getUint32(p);
    return out;
  }

  function pickIndices(n, k) {
    if (n <= k) return Array.from({ length: n }, (_, i) => i);
    const out = new Set([0, n - 1]);
    for (let i = 1; out.size < k; i++) out.add(Math.floor((i * (n - 1)) / (k - 1)) % n);
    return [...out].sort((a, b) => a - b);
  }

  async function sameBytes(a, ao, b, bo, len) {
    const [x, y] = await Promise.all([readRange(a, ao, ao + len), readRange(b, bo, bo + len)]);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function metaMatchesSpec(m, spec) {
    const v1ok = spec.v1
      ? !!(m.v1 && m.v1.wellFormed && m.v1.tags.ProjectionType === spec.v1.projectionType && (m.v1.tags.StereoMode || null) === (spec.v1.stereoMode || null))
      : !m.v1;
    let v2ok;
    if (!spec.v2) v2ok = !m.v2;
    else {
      const w = spec.v2;
      v2ok = !!m.v2 && (m.v2.st3d == null ? null : m.v2.st3d) === (w.stereo == null ? null : w.stereo);
      if (v2ok && w.projection) {
        const sv = m.v2.sv3d;
        v2ok = !!sv && (w.projection.kind === "cbmp" ? sv.projection === "cubemap"
          : sv.projection === "equirectangular" && Math.abs(sv.bounds.left - w.projection.bounds.left) < 1e-6 && Math.abs(sv.bounds.right - w.projection.bounds.right) < 1e-6);
      } else if (v2ok) v2ok = !m.v2.sv3d;
    }
    return { v1ok, v2ok };
  }

  /**
   * Independently re-read the output and prove it is correct: structure parses,
   * metadata reads back as intended, and media bytes at every sampled chunk /
   * fragment offset are identical to the original.
   */
  async function verify(original, output, before, p, opts) {
    const samples = (opts && opts.samples) || 64;
    const checks = [];
    let after;
    try {
      after = await analyze(output, { name: "output" });
      checks.push({ id: "parse", ok: true, label: "Output parses as a valid MP4/MOV" });
    } catch (e) {
      checks.push({ id: "parse", ok: false, label: "Output parses as a valid MP4/MOV", detail: e.message });
      return { ok: false, checks, after: null };
    }

    const sameTracks = after.tracks.length === before.tracks.length &&
      after.tracks.every((t, i) => t.sampleCount === before.tracks[i].sampleCount && t.chunkCount === before.tracks[i].chunkCount && t.codec === before.tracks[i].codec);
    checks.push({ id: "tracks", ok: sameTracks, label: `All ${before.tracks.length} track${before.tracks.length === 1 ? "" : "s"} intact (codecs, sample & chunk counts)` });

    const mm = metaMatchesSpec(after.meta, p.spec);
    const metaLabel = p.spec.v1 || p.spec.v2 ? "New metadata reads back exactly as written" : "Spherical metadata removed";
    checks.push({ id: "meta", ok: mm.v1ok && mm.v2ok, label: metaLabel, detail: mm.v1ok && mm.v2ok ? "" : `V1 ${mm.v1ok ? "ok" : "mismatch"}, V2 ${mm.v2ok ? "ok" : "mismatch"}` });

    // Media integrity: compare bytes at sampled chunk offsets (old offset in input vs new offset in output).
    let compared = 0, mismatched = 0;
    const perTrack = Math.max(4, Math.floor(samples / Math.max(1, before.tracks.length)));
    for (let i = 0; i < before.tracks.length; i++) {
      const a = readChunkOffsets(before, i);
      const b = readChunkOffsets(after, i);
      if (a.length !== b.length) { mismatched++; continue; }
      for (const k of pickIndices(a.length, perTrack)) {
        compared++;
        if (!(await sameBytes(original, a[k], output, b[k], 32))) mismatched++;
      }
    }
    const fa = before._raw.fragments.filter((f) => f.type === "moof" && f.dataPos != null);
    const fb = after._raw.fragments.filter((f) => f.type === "moof" && f.dataPos != null);
    if (fa.length) {
      if (fa.length !== fb.length) mismatched++;
      else for (const k of pickIndices(fa.length, 24)) {
        compared++;
        if (!(await sameBytes(original, fa[k].dataPos, output, fb[k].dataPos, 32))) mismatched++;
      }
    }
    if (compared) {
      checks.push({ id: "media", ok: mismatched === 0, label: `Media bytes identical at ${compared} sampled offset${compared === 1 ? "" : "s"}`, detail: mismatched ? `${mismatched} mismatch(es)` : "" });
    }
    const sizeOk = output.size === p.outputSize;
    checks.push({ id: "size", ok: sizeOk, label: "Output size matches the write plan" });
    return { ok: checks.every((c) => c.ok), checks, after };
  }

  // ───────────────────────────── reporting ─────────────────────────────

  /** JSON-safe report (no buffers). */
  function report(a) {
    const { _raw, ...rest } = a;
    return JSON.parse(JSON.stringify(rest, (k, v) => (k === "_chunks" ? undefined : v)));
  }

  /** Box tree for display: top level + the full moov subtree, with offsets. */
  function boxTree(a) {
    const { moovU8, moovBox } = a._raw;
    const tree = parseTree(moovU8);
    const toView = (n) => {
      const o = { type: n.type, offset: moovBox.start + n.start, size: n.end - n.start };
      if (n.type === "uuid" && isGsUuid(n, moovU8)) o.note = "GSpherical V1";
      if (n.type === "st3d" || n.type === "sv3d") o.note = "Spherical V2";
      if (n.type === "vexu") o.note = "Apple";
      if (n.type === "SA3D") o.note = "Spatial audio";
      if (n.type === "trak" && n.handler) o.note = { vide: "video", soun: "audio", tmcd: "timecode", meta: "metadata", text: "text", sbtl: "subtitle" }[n.handler] || n.handler;
      if (n.children && n.children.length) o.children = n.children.map(toView);
      return o;
    };
    return a.topLevel.map((b) => (b.start === moovBox.start ? toView(tree.children[0]) : { type: b.type, offset: b.start, size: b.size }));
  }

  return {
    SOFTWARE, GS_UUID_HEX, FORMATS, CODECS, MetaFixError,
    analyze, plan, buildSpec, buildBlob, verify, report, boxTree,
    keyFor, fovBucket,
    // exposed for tests / power users
    _internal: { parseTree, buildV1Xml, parseV1Xml, buildSv3d, buildSt3d, serialize, readChunkOffsets, interpretV1, interpretV2 }
  };
});
