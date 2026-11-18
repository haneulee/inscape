import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FlyControls } from './controls.js';

const FOV = 70;
const WORLD = 2.4;          // nearest surface distance
const COPIES = 4;           // the photo is wrapped 360° as 4 mirrored copies → seamless all round
const SPAN = (Math.PI * 2) / COPIES;
const BG = new THREE.Color(0, 0, 0);

/* ------------------------------------------------------------------ shaders */

const common = /* glsl */ `
  uniform float uTime, uGather, uDepth, uProj, uLevel, uScan, uScanOn, uPointMix;
  float h(float n) { return fract(sin(n) * 43758.5453123); }
  float scanAt(float u) { float s = u - uScan; return exp(-s * s * 1600.0) * uScanOn; }
`;

const meshVert = /* glsl */ `
  ${common}
  attribute vec3 aFlat;
  attribute float aEdge, aDim, aOver;
  varying vec2 vUv;
  varying float vFog, vEdge, vDim, vOver;
  void main() {
    vOver = aOver;
    float d = smoothstep(0.0, 1.0, uDepth);
    vec3 p = mix(aFlat, position, d);
    p *= 1.0 + sin(uTime * 0.6 + length(position) * 0.4) * 0.004 * uLevel;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    vUv = uv; vEdge = aEdge * d; vDim = aDim;
    vFog = smoothstep(22.0, 70.0, length(mv.xyz));
  }
`;
const meshFrag = /* glsl */ `
  ${common}
  uniform sampler2D uTex;
  uniform float uBright, uFade, uCut;
  uniform vec3 uBg;
  varying vec2 vUv;
  varying float vFog, vEdge, vDim, vOver;
  void main() {
    if (vEdge > uCut) discard;
    vec3 c = texture2D(uTex, vUv).rgb * vDim * uBright * (1.0 + uLevel * 0.18);
    float sc = scanAt(vUv.x);
    c += sc * (0.2 + c * 1.5);
    gl_FragColor = vec4(mix(c, uBg, vFog), uFade);
  }
`;

const pointVert = /* glsl */ `
  ${common}
  attribute vec3 aFlat;
  attribute float aSize, aRand, aNear, aDim;
  attribute vec2 aUv;
  varying vec3 vColor;
  varying float vFog;
  void main() {
    float g = smoothstep(0.0, 1.0, clamp(uGather * 1.6 - aRand * 0.6, 0.0, 1.0));
    vec3 scat = aFlat * 1.3 + (vec3(h(aRand * 91.7), h(aRand * 13.3), h(aRand * 57.1)) - 0.5) * vec3(36.0, 22.0, 36.0);
    vec3 p = mix(scat, aFlat, g);
    float d = smoothstep(0.0, 1.0, clamp(uDepth * 1.5 - (1.0 - aNear) * 0.5, 0.0, 1.0));
    p = mix(p, position, d);

    float dist = length(position);
    p += vec3(sin(uTime * 0.7 + aRand * 40.0), cos(uTime * 0.9 + aRand * 30.0), sin(uTime * 0.5 + aRand * 20.0))
         * (0.003 + uLevel * 0.03) * dist * d;
    float sc = scanAt(aUv.x);
    p.y += sc * 0.01 * dist * (0.5 + aRand);

    // surface mode: only a sparse, small dust layer survives; points mode: every pixel
    float keep = mix(step(aRand, 0.22) * 0.55, 1.0, uPointMix);
    keep = max(keep, 1.0 - d * (1.0 - keep)); // full density while assembling

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float z = max(-mv.z, 0.05);
    gl_PointSize = clamp(aSize * keep * uProj / z * (1.0 + sc * 0.8), 0.0, 30.0);
    gl_Position = projectionMatrix * mv;

    float tw = 0.85 + 0.15 * sin(uTime * (1.0 + aRand * 2.0) + aRand * 60.0);
    float lift = mix(1.35, 1.0, uPointMix); // dust glints a little brighter than the surface
    vColor = color * aDim * tw * lift * (1.0 + uLevel * 0.25) + sc * (0.3 + color * 1.6);
    vFog = smoothstep(22.0, 70.0, length(mv.xyz));
  }
`;
const pointFrag = /* glsl */ `
  uniform vec3 uBg;
  varying vec3 vColor;
  varying float vFog;
  void main() { gl_FragColor = vec4(mix(vColor, uBg, vFog), 1.0); }
`;

const motesVert = /* glsl */ `
  attribute float aRand;
  attribute vec3 aColor;
  uniform float uTime, uProj, uHigh, uLevel;
  varying vec3 vColor;
  varying float vA;
  void main() {
    vec3 p = position;
    float t = uTime * (0.05 + aRand * 0.08);
    p += vec3(sin(t + aRand * 9.0) * 1.6, sin(t * 1.3 + aRand * 5.0) * 0.9, cos(t * 0.8 + aRand * 7.0) * 1.6);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float z = max(-mv.z, 0.1);
    float pulse = 0.6 + 0.4 * sin(uTime * (0.6 + aRand) + aRand * 30.0);
    gl_PointSize = clamp((0.05 + aRand * 0.08) * uProj / z * (1.0 + uHigh * 2.5), 0.0, 40.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vA = pulse * (0.35 + uLevel * 0.9) * (1.0 - smoothstep(18.0, 40.0, z));
  }
`;
const motesFrag = /* glsl */ `
  varying vec3 vColor;
  varying float vA;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, r);
    gl_FragColor = vec4(vColor * a * a * vA * 1.8, 1.0);
  }
`;

/* ------------------------------------------------------------------ helpers */

/** direction on the sphere for image coords (u,v) of copy k (odd copies are mirrored) */
function direction(u, v, k, vSpan, out) {
  const a = (k % 2 === 0 ? u - 0.5 : 0.5 - u) * SPAN;
  const th = k * SPAN + a;
  const ph = (0.5 - v) * vSpan;
  const c = Math.cos(ph);
  out[0] = Math.sin(th) * c; out[1] = Math.sin(ph); out[2] = -Math.cos(th) * c;
  return th;
}
const dimFor = (th) => 0.5 + 0.5 * (0.5 + 0.5 * Math.cos(th)); // the copy you face is brightest

function bilinear(dm, u, v) {
  const x = Math.min(dm.w - 1, Math.max(0, u * (dm.w - 1)));
  const y = Math.min(dm.h - 1, Math.max(0, v * (dm.h - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(dm.w - 1, x0 + 1), y1 = Math.min(dm.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, d = dm.data;
  const a = d[y0 * dm.w + x0] * (1 - fx) + d[y0 * dm.w + x1] * fx;
  const b = d[y1 * dm.w + x0] * (1 - fx) + d[y1 * dm.w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

function filter(dm, r, fn) {
  const { w, h, data } = dm, o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const vals = [];
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y + j));
      vals.push(data[yy * w + xx]);
    }
    o[y * w + x] = fn(vals);
  }
  return { w, h, data: o };
}

/* ------------------------------------------------------------------ world */

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 300);
    this.controls = new FlyControls(this.camera, canvas);
    this.controls.enabled = false;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.uniforms = {
      uTime: { value: 0 }, uGather: { value: 0 }, uDepth: { value: 0 }, uProj: { value: 500 },
      uLevel: { value: 0 }, uHigh: { value: 0 }, uScan: { value: -1 }, uScanOn: { value: 0 },
      uPointMix: { value: 0 }, uBg: { value: BG.clone() },
    };
    this.mode = 'surface';
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.meshes = [];

    this.motes = this.#makeMotes([[0.79, 0.71, 1], [0.56, 0.94, 1], [1, 1, 1]]);
    this.scene.add(this.motes);

    this.clock = new THREE.Clock();
    this.anim = null;
    this.audio = { level: 0, high: 0, scan: -1 };
    this.idle = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dbh = h * this.renderer.getPixelRatio();
    this.uniforms.uProj.value = dbh / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
  }

  setMode(mode) { this.mode = mode; }

  #makeMotes(palette, count = 900) {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 2.5 + Math.random() * 22, th = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(th) * r;
      pos[i * 3 + 1] = (Math.random() - 0.4) * 10;
      pos[i * 3 + 2] = Math.sin(th) * r;
      const [pr, pg, pb] = palette[i % palette.length];
      const c = new THREE.Color().setRGB(pr, pg, pb, THREE.SRGBColorSpace);
      col.set([c.r, c.g, c.b], i * 3);
      rnd[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: motesVert, fragmentShader: motesFrag, uniforms: this.uniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    return pts;
  }

  setPalette(rgbList) {
    const bright = rgbList.map(([r, g, b]) => {
      const c = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      const hsl = {}; c.getHSL(hsl);
      c.setHSL(hsl.h, Math.min(1, hsl.s * 1.3 + 0.25), Math.max(0.62, hsl.l));
      const o = {}; c.getRGB(o, THREE.SRGBColorSpace);
      return [o.r, o.g, o.b];
    });
    this.scene.remove(this.motes);
    this.motes.geometry.dispose();
    this.motes = this.#makeMotes(bright);
    this.scene.add(this.motes);
  }

  #dist(near01) {
    // relative inverse depth → distance; exaggerated so the space feels deep (2.4 … ~48)
    return WORLD / (0.05 + 0.95 * Math.pow(Math.min(1, Math.max(0, near01)), 1.25));
  }

  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.image   texture source
   * @param {{w,h,data:Float32Array}} o.depth  0..1, 1 = nearest
   * @param {{w,h,rgb}} o.points  per-copy point grid colours
   * @param {number} o.meshW   mesh columns per copy
   */
  build({ image, depth, points, meshW }) {
    this.clear(false);
    const aspect = image.width / image.height;
    this.vSpan = Math.min(SPAN / aspect, 2.5);
    this.flatDist = this.#dist(Float32Array.from(depth.data).sort()[Math.floor(depth.data.length * 0.5)]);

    const tex = new THREE.CanvasTexture(image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.texture = tex;
    // a tiny copy of the photo = a soft, blurred version for the backdrop/sky/floor
    const small = document.createElement('canvas');
    small.width = 40; small.height = Math.max(4, Math.round(40 / aspect));
    small.getContext('2d').drawImage(image, 0, 0, small.width, small.height);
    const soft = new THREE.CanvasTexture(small);
    soft.colorSpace = THREE.SRGBColorSpace;
    soft.generateMipmaps = false;
    soft.minFilter = soft.magFilter = THREE.LinearFilter;
    this.soft = soft;

    // 1) blurred backdrop pushed behind everything — fills the holes that open when you move
    const far = filter(filter(depth, 5, (v) => Math.min(...v)), 5, (v) => v.reduce((a, b) => a + b) / v.length);
    //    it also extends past the photo's top/bottom into a soft sky dome and floor, so you're enclosed
    const back = this.#mesh(far, Math.round(meshW / 3), 1.1, { tex: soft, uBright: 0.6, uCut: 2, extend: 1.5 });
    // 2) the main surface, torn open at depth edges
    const surf = this.#mesh(depth, meshW, 1.0, { tex, uBright: 1, uCut: 0.5 });
    // 3) points
    const pts = this.#points(depth, points);
    this.meshes = [back, surf];
    this.points = pts;
    this.group.add(back, surf, pts);
  }

  #mesh(dm, mw, push, opts) {
    // v range in image units; beyond [0,1] the edge pixels are smeared outward (clamped uv)
    const half = Math.max(this.vSpan / 2, opts.extend ?? 0);
    const v0 = 0.5 - half / this.vSpan, v1 = 0.5 + half / this.vSpan;
    const mh = Math.max(8, Math.round(mw * ((half * 2) / SPAN)));
    const vAt = (y) => v0 + (y / (mh - 1)) * (v1 - v0);
    const per = mw * mh, n = per * COPIES;
    const pos = new Float32Array(n * 3), flat = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const edge = new Float32Array(n), dim = new Float32Array(n), overA = new Float32Array(n);
    const dist = new Float32Array(per);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const v = vAt(y), over = Math.max(0, -v, v - 1) * this.vSpan;
      // beyond the photo: floor stays near, sky drifts far
      const base = this.#dist(bilinear(dm, x / (mw - 1), Math.min(1, Math.max(0, v))));
      dist[y * mw + x] = base * push * (v < 0 ? 1 + over * 0.8 : 1);
    }
    // how torn is this vertex: max ratio to a neighbour's distance
    const ratio = new Float32Array(per);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const i = y * mw + x, d = dist[i];
      let r = 1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= mw || yy >= mh) continue;
        const e = dist[yy * mw + xx];
        r = Math.max(r, Math.max(e, d) / Math.min(e, d));
      }
      ratio[i] = THREE.MathUtils.smoothstep(r, 1.12, 1.32);
    }
    const dir = [0, 0, 0];
    for (let k = 0; k < COPIES; k++) {
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
        const j = y * mw + x, i = k * per + j;
        const u = x / (mw - 1), v = vAt(y);
        const th = direction(u, v, k, this.vSpan, dir);
        const over = Math.max(0, -v, v - 1) * this.vSpan;
        const d = dist[j];
        pos.set([dir[0] * d, dir[1] * d, dir[2] * d], i * 3);
        flat.set([dir[0] * this.flatDist * push, dir[1] * this.flatDist * push, dir[2] * this.flatDist * push], i * 3);
        uv[i * 2] = u; uv[i * 2 + 1] = 1 - Math.min(1, Math.max(0, v));
        edge[i] = ratio[j];
        dim[i] = dimFor(th) * Math.max(0.05, Math.exp(-over * 2.2));
        overA[i] = over;
      }
    }
    const idx = new Uint32Array((mw - 1) * (mh - 1) * 6 * COPIES);
    let o = 0;
    for (let k = 0; k < COPIES; k++) for (let y = 0; y < mh - 1; y++) for (let x = 0; x < mw - 1; x++) {
      const a = k * per + y * mw + x, b = a + 1, c = a + mw, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aFlat', new THREE.BufferAttribute(flat, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
    g.setAttribute('aDim', new THREE.BufferAttribute(dim, 1));
    g.setAttribute('aOver', new THREE.BufferAttribute(overA, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: meshVert, fragmentShader: meshFrag, side: THREE.DoubleSide, transparent: true,
      uniforms: {
        ...this.uniforms, uTex: { value: opts.tex }, uFade: { value: 0 }, uBright: { value: opts.uBright }, uCut: { value: opts.uCut },
      },
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }

  #points(dm, grid) {
    const { w, h, rgb } = grid;
    const per = w * h, n = per * COPIES;
    const pos = new Float32Array(n * 3), flat = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const size = new Float32Array(n), rnd = new Float32Array(n), near = new Float32Array(n), uv = new Float32Array(n * 2), dim = new Float32Array(n);
    const c = new THREE.Color(), dir = [0, 0, 0];
    const angStep = SPAN / w;
    for (let k = 0; k < COPIES; k++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = y * w + x, i = k * per + j;
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      const jit = (Math.random() - 0.5) * 0.04;
      const dn = Math.min(1, Math.max(0, bilinear(dm, u, v) + jit * 0.3));
      const d = this.#dist(dn) * (0.985 + jit); // sit just in front of the surface
      const th = direction(u, v, k, this.vSpan, dir);
      pos.set([dir[0] * d, dir[1] * d, dir[2] * d], i * 3);
      flat.set([dir[0] * this.flatDist, dir[1] * this.flatDist, dir[2] * this.flatDist], i * 3);
      c.setRGB(rgb[j * 4] / 255, rgb[j * 4 + 1] / 255, rgb[j * 4 + 2] / 255).convertSRGBToLinear();
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = angStep * d * (0.72 + Math.random() * 0.5);
      rnd[i] = Math.random();
      near[i] = dn;
      uv[i * 2] = u; uv[i * 2 + 1] = v;
      dim[i] = dimFor(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aFlat', new THREE.BufferAttribute(flat, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    g.setAttribute('aNear', new THREE.BufferAttribute(near, 1));
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aDim', new THREE.BufferAttribute(dim, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: pointVert, fragmentShader: pointFrag, uniforms: this.uniforms, vertexColors: true });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  dive(onUnfold) {
    this.controls.enabled = false;
    this.controls.reset(new THREE.Vector3(), 0, 0);
    this.uniforms.uGather.value = 0;
    this.uniforms.uDepth.value = 0;
    this.anim = { t: 0, fired: false, onUnfold };
  }

  clear(resetCamera = true) {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    this.texture?.dispose(); this.soft?.dispose();
    this.texture = this.soft = null;
    this.meshes = []; this.points = null;
    this.anim = null;
    if (resetCamera) {
      this.controls.enabled = false;
      this.controls.reset(new THREE.Vector3(), 0, 0);
    }
  }

  #tick() {
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 0.05);
    const U = this.uniforms;
    U.uTime.value += dt;
    U.uLevel.value += (this.audio.level - U.uLevel.value) * 0.25;
    U.uHigh.value += (this.audio.high - U.uHigh.value) * 0.3;
    U.uScan.value = this.audio.scan;
    U.uScanOn.value += ((this.audio.scan >= 0 ? 1 : 0) - U.uScanOn.value) * 0.05;
    U.uPointMix.value += ((this.mode === 'points' ? 1 : 0) - U.uPointMix.value) * (1 - Math.exp(-dt * 4));

    const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    let fade = 1;
    if (this.anim) {
      const a = this.anim;
      a.t += Math.min(raw, 0.25); // wall-clock, so slow devices never stall the intro
      U.uGather.value = ease(a.t / 2.2);
      const unfold = (a.t - 2.4) / 3.4;
      U.uDepth.value = ease(unfold);
      fade = ease((a.t - 1.6) / 1.4);
      if (unfold > 0 && !a.fired) { a.fired = true; a.onUnfold?.(); }
      const k = ease((a.t - 2.6) / 4.4);
      const s = Math.sin(k * Math.PI);
      this.controls.pos.set(s * 0.5, -0.15 * k, -1.2 * k);
      this.controls.yaw = -s * 0.35;
      this.controls.pitch = -0.04 * k;
      if (a.t > 7.2) { this.anim = null; this.controls.enabled = true; }
    } else if (!this.points) {
      this.idle += dt * 0.02;
      this.controls.yaw = Math.sin(this.idle) * 0.25;
    }
    const pm = U.uPointMix.value;
    for (const m of this.meshes) {
      m.material.uniforms.uFade.value = fade * (1 - pm);
      m.visible = fade * (1 - pm) > 0.01;
      m.material.depthWrite = fade > 0.99;
    }

    this.controls.update(dt);
    this.composer.render();
  }
}
