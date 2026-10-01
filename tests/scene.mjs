// Procedural test scenes with ground truth: a textured room with nearby objects,
// ray-cast from one or two eyes (real parallax) into any projection.
// Used to unit-test smart detection and to build browser e2e fixtures.

function hash3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), xf), l(c(0, 1, 0), c(1, 1, 0), xf), yf),
    l(l(c(0, 0, 1), c(1, 0, 1), xf), l(c(0, 1, 1), c(1, 1, 1), xf), yf), zf);
}
function fbm(x, y, z) {
  let a = 0.5, f = 1, s = 0;
  for (let o = 0; o < 6; o++) { s += a * vnoise(x * f, y * f, z * f); a *= 0.5; f *= 2.03; }
  return s;
}

const BALLS = [
  { c: [1.2, -0.3, -2.5], r: 0.7, tint: [1.0, 0.75, 0.55] },
  { c: [-1.8, 0.2, -3.2], r: 0.9, tint: [0.6, 0.85, 1.0] },
  { c: [2.8, 0.6, 1.5], r: 1.0, tint: [0.8, 1.0, 0.7] },
  { c: [-2.2, -0.8, 2.4], r: 0.8, tint: [1.0, 0.6, 0.8] }
];
const ROOM = 9;

function shade(o, d) {
  // Nearest ball hit.
  let best = Infinity, ball = null;
  for (const b of BALLS) {
    const ox = o[0] - b.c[0], oy = o[1] - b.c[1], oz = o[2] - b.c[2];
    const bb = ox * d[0] + oy * d[1] + oz * d[2];
    const cc = ox * ox + oy * oy + oz * oz - b.r * b.r;
    const disc = bb * bb - cc;
    if (disc < 0) continue;
    const t = -bb - Math.sqrt(disc);
    if (t > 0 && t < best) { best = t; ball = b; }
  }
  if (ball) {
    const p = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
    const n = fbm(p[0] * 3, p[1] * 3, p[2] * 3);
    const light = 0.55 + 0.45 * ((p[1] - ball.c[1]) / ball.r);
    return ball.tint.map((t) => Math.min(1, t * n * light * 1.4));
  }
  // Room sphere: sky above, textured ground below.
  const bb = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const t = -bb + Math.sqrt(bb * bb - (o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - ROOM * ROOM));
  const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const n = fbm(p[0] * 0.5 + 11, p[1] * 0.5, p[2] * 0.5);
  const y = p[1] / ROOM;
  if (y > 0.05) {
    const sky = 0.55 + 0.35 * y;
    return [sky * 0.75 + n * 0.25, sky * 0.85 + n * 0.2, Math.min(1, sky + n * 0.15)];
  }
  const g = 0.15 + 0.6 * n;
  return [g * 0.9, g * 0.8, g * 0.6];
}

function rotY(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

/** Render one eye. proj: "equi" (lonSpan 360/180) | "persp" | "fisheye". */
export function renderEye(width, height, { proj = "equi", lonSpan = 360, hfov = 70, fisheyeFov = 190, eye = 0, yaw = 0, seed = 0 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const origin = rotY([eye * 0.032, 0, 0], yaw);
  const tf = Math.tan((hfov * Math.PI) / 360);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let d = null;
      if (proj === "equi") {
        const lon = ((x + 0.5) / width - 0.5) * lonSpan * (Math.PI / 180);
        const lat = (0.5 - (y + 0.5) / height) * Math.PI;
        d = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), -Math.cos(lat) * Math.cos(lon)];
      } else if (proj === "persp") {
        const u = ((x + 0.5) / width * 2 - 1) * tf, v = (1 - (y + 0.5) / height * 2) * tf * (height / width);
        const m = Math.hypot(u, v, 1);
        d = [u / m, v / m, -1 / m];
      } else {
        const u = (x + 0.5) / width * 2 - 1, v = 1 - (y + 0.5) / height * 2;
        const r = Math.hypot(u, v);
        if (r <= 1) {
          const th = (r * fisheyeFov * Math.PI) / 360, ph = Math.atan2(v, u);
          d = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th)];
        }
      }
      const i = (y * width + x) * 4;
      if (!d) { data[i + 3] = 255; continue; }
      const c = shade(origin, rotY(d, yaw));
      // Per-eye sensor noise so stereo halves are never pixel-identical.
      const nz = (hash3(x, y, seed * 7 + eye * 3 + 1) - 0.5) * 0.06;
      data[i] = (c[0] + nz) * 255; data[i + 1] = (c[1] + nz) * 255; data[i + 2] = (c[2] + nz) * 255; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function stack(a, b, horizontal) {
  const width = horizontal ? a.width + b.width : a.width;
  const height = horizontal ? a.height : a.height + b.height;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < a.height; y++) data.set(a.data.subarray(y * a.width * 4, (y + 1) * a.width * 4), y * width * 4);
  for (let y = 0; y < b.height; y++) {
    const dst = horizontal ? (y * width + a.width) * 4 : ((a.height + y) * width) * 4;
    data.set(b.data.subarray(y * b.width * 4, (y + 1) * b.width * 4), dst);
  }
  return { data, width, height };
}

/** Render a full frame for a format key, e.g. "180-sbs". eyeW = width of one eye view. */
export function renderFormat(key, eyeW, opts = {}) {
  const [fov, stereo] = key.split("-");
  let eyeH, base;
  if (fov === "360") { eyeH = eyeW / 2; base = { proj: "equi", lonSpan: 360 }; }
  else if (fov === "180") { eyeH = eyeW; base = { proj: "equi", lonSpan: 180 }; }
  else if (fov === "fisheye") { eyeH = eyeW; base = { proj: "fisheye" }; }
  else { eyeH = Math.round((eyeW * 9) / 16); base = { proj: "persp" }; }
  const o = { ...base, ...opts };
  if (stereo === "mono") return renderEye(eyeW, eyeH, { ...o, eye: 0 });
  const l = renderEye(eyeW, eyeH, { ...o, eye: -1 });
  const r = renderEye(eyeW, eyeH, { ...o, eye: 1 });
  return stack(l, r, stereo === "sbs");
}
