/*!
 * 3DmetaFix VR preview — a tiny WebGL viewer that shows a video exactly the way a
 * headset would interpret the chosen metadata: 360° or 180° equirect, mono or
 * stereo (left eye, right eye or red/cyan anaglyph), or flat 3D.
 *
 * One full-screen triangle; the fragment shader ray-casts every pixel onto the
 * sphere, so there is no mesh, no seams and no dependency.
 */
(function (root) {
  "use strict";

  const VERT = `
attribute vec2 aPos;
varying vec2 vPos;
void main() { vPos = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vPos;
uniform sampler2D uTex;
uniform float uYaw, uPitch, uTanHalf, uAspect;
uniform float uCover;      // horizontal coverage in radians; 0 = flat
uniform float uLayout;     // 0 mono, 1 side-by-side, 2 top-bottom
uniform float uEye;        // 0 left, 1 right, 2 anaglyph
uniform float uEyeAspect;  // flat mode: width/height of one eye view
uniform float uZoom;       // flat mode zoom
const vec3 VOID = vec3(0.035, 0.04, 0.055);

vec2 toEye(vec2 uv, float eye) {
  if (uLayout > 0.5 && uLayout < 1.5) return vec2(uv.x * 0.5 + eye * 0.5, uv.y);
  if (uLayout > 1.5) return vec2(uv.x, uv.y * 0.5 + eye * 0.5);
  return uv;
}

vec3 sampleEye(float eye) {
  vec2 uv;
  if (uCover < 0.01) {
    vec2 s = uAspect > uEyeAspect ? vec2(uAspect / uEyeAspect, 1.0) : vec2(1.0, uEyeAspect / uAspect);
    uv = (vPos * s / uZoom) * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return VOID;
  } else {
    vec3 d = normalize(vec3(vPos.x * uTanHalf * uAspect, vPos.y * uTanHalf, -1.0));
    float cp = cos(uPitch), sp = sin(uPitch);
    d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
    float cy = cos(uYaw), sy = sin(uYaw);
    d = vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    uv = vec2(lon / uCover + 0.5, 0.5 - lat / 3.14159265);
    if (uv.x < 0.0 || uv.x > 1.0) return VOID;
  }
  return texture2D(uTex, toEye(uv, eye)).rgb;
}

void main() {
  vec3 c;
  if (uEye > 1.5) {
    vec3 l = sampleEye(0.0), r = sampleEye(1.0);
    c = vec3(dot(l, vec3(0.299, 0.587, 0.114)), dot(r, vec3(0.0, 0.7, 0.3)), dot(r, vec3(0.0, 0.3, 0.7)));
  } else {
    c = sampleEye(uEye);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

  const DEG = Math.PI / 180;

  class MetaViewer {
    constructor(canvas, video) {
      this.canvas = canvas;
      this.video = video;
      this.format = { fov: 360, stereo: "mono" };
      this.eye = 0;
      this.yaw = 0; this.pitch = 0; this.vfov = 75 * DEG; this.zoom = 1;
      this.vel = { yaw: 0, pitch: 0 };
      this.dirty = true;
      this.hasFrame = false;
      this.interacted = false;
      this.onInteract = null;
      const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
      this.supported = !!gl;
      if (!gl) return;
      this.gl = gl;
      this._init();
      this._bind();
      this._loop = this._loop.bind(this);
      this.raf = requestAnimationFrame(this._loop);
    }

    _init() {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(p);
      gl.useProgram(p);
      this.u = {};
      for (const n of ["uTex", "uYaw", "uPitch", "uTanHalf", "uAspect", "uCover", "uLayout", "uEye", "uEyeAspect", "uZoom"]) this.u[n] = gl.getUniformLocation(p, n);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([9, 10, 14]));
      this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.texSize = [1, 1];
    }

    _bind() {
      const c = this.canvas;
      let drag = null;
      const pointers = new Map(); // active touches/mice, for drag + pinch-zoom
      let pinch = null;
      const mark = () => {
        if (!this.interacted) { this.interacted = true; this.onInteract && this.onInteract(); }
      };
      const spread = () => {
        const [a, b] = [...pointers.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
      };
      c.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        c.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.vel.yaw = this.vel.pitch = 0;
        if (pointers.size === 2) {
          drag = null;
          pinch = { d: spread(), vfov: this.vfov, zoom: this.zoom };
        } else if (pointers.size === 1) {
          drag = { x: e.clientX, y: e.clientY, t: performance.now() };
          c.classList.add("dragging");
        }
        mark();
      });
      c.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size === 2) {
          const k = pinch.d / Math.max(1, spread());
          if (this._spherical()) this.vfov = Math.min(120 * DEG, Math.max(30 * DEG, pinch.vfov * k));
          else this.zoom = Math.min(4, Math.max(1, pinch.zoom / k));
          this.dirty = true;
          return;
        }
        if (!drag) return;
        const k = this._radPerPx();
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        const now = performance.now(), dt = Math.max(1, now - drag.t);
        if (this._spherical()) {
          this.yaw -= dx * k;
          this.pitch = this._clampPitch(this.pitch + dy * k);
          this.vel.yaw = (-dx * k) / dt * 16;
          this.vel.pitch = (dy * k) / dt * 16;
        }
        drag = { x: e.clientX, y: e.clientY, t: now };
        this.dirty = true;
      });
      const end = (e) => {
        pointers.delete(e.pointerId);
        try { c.releasePointerCapture(e.pointerId); } catch (_) {}
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 1) {
          const [p] = pointers.values();
          drag = { x: p.x, y: p.y, t: performance.now() };
          this.vel.yaw = this.vel.pitch = 0;
        } else if (!pointers.size) {
          drag = null;
          c.classList.remove("dragging");
        }
      };
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", end);
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        mark();
        if (this._spherical()) this.vfov = Math.min(120 * DEG, Math.max(30 * DEG, this.vfov * Math.exp(e.deltaY * 0.0012)));
        else this.zoom = Math.min(4, Math.max(1, this.zoom * Math.exp(-e.deltaY * 0.0012)));
        this.dirty = true;
      }, { passive: false });
      c.addEventListener("dblclick", () => this.reset());
      c.addEventListener("keydown", (e) => {
        const step = 5 * DEG;
        const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (map[e.key] && this._spherical()) {
          e.preventDefault();
          mark();
          this.yaw += map[e.key][0];
          this.pitch = this._clampPitch(this.pitch + map[e.key][1]);
          this.dirty = true;
        }
      });
      this.ro = new ResizeObserver(() => { this.dirty = true; });
      this.ro.observe(c);
      const v = this.video;
      for (const ev of ["loadeddata", "seeked", "play"]) v.addEventListener(ev, () => { this.needUpload = true; });
    }

    _spherical() { return this.format.fov !== "flat"; }
    _clampPitch(p) { return Math.max(-85 * DEG, Math.min(85 * DEG, p)); }
    _radPerPx() { return (2 * Math.tan(this.vfov / 2)) / Math.max(1, this.canvas.clientHeight) * 0.9; }

    setFormat(fmt) {
      this.format = { fov: fmt.fov, stereo: fmt.stereo };
      if (fmt.fov === 180 && Math.abs(this.yaw) > 80 * DEG) this.yaw = 0;
      this.dirty = true;
    }
    setEye(eye) { this.eye = eye === "right" ? 1 : eye === "anaglyph" ? 2 : 0; this.dirty = true; }
    reset() { this.yaw = 0; this.pitch = 0; this.vfov = 75 * DEG; this.zoom = 1; this.vel.yaw = this.vel.pitch = 0; this.dirty = true; }

    _upload() {
      const gl = this.gl, v = this.video;
      if (v.readyState < 2 || !v.videoWidth) return false;
      let src = v, w = v.videoWidth, h = v.videoHeight;
      if (w > this.maxTex || h > this.maxTex) {
        const s = Math.min(this.maxTex / w, this.maxTex / h);
        w = Math.floor(w * s); h = Math.floor(h * s);
        if (!this.scaler) this.scaler = document.createElement("canvas");
        this.scaler.width = w; this.scaler.height = h;
        this.scaler.getContext("2d").drawImage(v, 0, 0, w, h);
        src = this.scaler;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      try {
        if (this.texSize[0] === w && this.texSize[1] === h) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, src);
        else { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src); this.texSize = [w, h]; }
      } catch (_) {
        return false;
      }
      this.hasFrame = true;
      return true;
    }

    _loop() {
      this.raf = requestAnimationFrame(this._loop);
      const v = this.video;
      if ((!v.paused && !v.ended) || this.needUpload) {
        if (this._upload()) { this.needUpload = false; this.dirty = true; }
      }
      if (Math.abs(this.vel.yaw) + Math.abs(this.vel.pitch) > 1e-5) {
        this.yaw += this.vel.yaw;
        this.pitch = this._clampPitch(this.pitch + this.vel.pitch);
        this.vel.yaw *= 0.9; this.vel.pitch *= 0.9;
        this.dirty = true;
      }
      if (this.dirty) this._draw();
    }

    _draw() {
      this.dirty = false;
      const gl = this.gl, c = this.canvas;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.viewport(0, 0, w, h);
      const f = this.format;
      const layout = f.stereo === "sbs" ? 1 : f.stereo === "tb" ? 2 : 0;
      const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
      const eyeAspect = layout === 1 ? vw / 2 / vh : layout === 2 ? vw / (vh / 2) : vw / vh;
      gl.uniform1i(this.u.uTex, 0);
      gl.uniform1f(this.u.uYaw, this.yaw);
      gl.uniform1f(this.u.uPitch, this.pitch);
      gl.uniform1f(this.u.uTanHalf, Math.tan(this.vfov / 2));
      gl.uniform1f(this.u.uAspect, w / h);
      gl.uniform1f(this.u.uCover, f.fov === "flat" ? 0 : (f.fov === 180 ? 180 : 360) * DEG);
      gl.uniform1f(this.u.uLayout, layout);
      gl.uniform1f(this.u.uEye, layout === 0 ? 0 : this.eye);
      gl.uniform1f(this.u.uEyeAspect, eyeAspect);
      gl.uniform1f(this.u.uZoom, this.zoom);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      if (this.ro) this.ro.disconnect();
      const lose = this.gl && this.gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    }
  }

  root.MetaViewer = MetaViewer;
})(typeof self !== "undefined" ? self : globalThis);
