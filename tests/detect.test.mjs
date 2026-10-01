// Smart-detect tests on procedurally rendered scenes with known ground truth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { renderFormat } from "./scene.mjs";

const require = createRequire(import.meta.url);
const MetaDetect = require("../js/detect.js");

const YAWS = [0, 0.9, 2.3]; // three "moments" of the clip
const frames = (key, eyeW, extra = {}) => YAWS.map((yaw, i) => renderFormat(key, eyeW, { yaw, seed: i, ...extra }));

const KEYS = ["360-mono", "360-tb", "360-sbs", "180-sbs", "180-tb", "180-mono", "flat-mono", "flat-sbs", "flat-tb"];

for (const key of KEYS) {
  test(`detects ${key}`, () => {
    const eyeW = key.startsWith("360") ? 320 : 200;
    const r = MetaDetect.analyzeFrames(frames(key, eyeW));
    const f = r.features;
    const dbg = `got ${r.key} p=${r.confidence.toFixed(2)} sbs=${f.sbs.toFixed(2)} tb=${f.tb.toFixed(2)} seam=${f.seam.toFixed(2)} pole=${f.pole.toFixed(2)} rank=${JSON.stringify(r.ranking.map((x) => `${x.key}:${x.p.toFixed(2)}`))}`;
    assert.equal(r.key, key, dbg);
    assert.ok(r.confidence >= 0.6, `low confidence: ${dbg}`);
    assert.equal(r.fisheye, false, dbg);
    assert.ok(r.reasons.length >= 2);
  });
}

test("flags circular fisheye footage", () => {
  const r = MetaDetect.analyzeFrames(frames("fisheye-sbs", 200));
  assert.equal(r.stereo, "sbs");
  assert.equal(r.fisheye, true);
});

test("ignores black frames and returns null when nothing is usable", () => {
  const black = { data: new Uint8ClampedArray(320 * 160 * 4).fill(0), width: 320, height: 160 };
  assert.equal(MetaDetect.analyzeFrames([black]), null);
  const r = MetaDetect.analyzeFrames([black, ...frames("360-mono", 320).slice(0, 1)]);
  assert.equal(r.key, "360-mono");
  assert.equal(r.features.frames, 1);
});

test("dimension priors", () => {
  assert.deepEqual(MetaDetect.fromDimensions(5760, 2880), ["180-sbs", "360-mono"]);
  assert.deepEqual(MetaDetect.fromDimensions(3840, 3840), ["360-tb", "180-mono"]);
  assert.deepEqual(MetaDetect.fromDimensions(1920, 1080), ["flat-mono"]);
});
