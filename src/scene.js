import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitFly } from './controls.js';

const FOV = 50;              // projection used to lift the photo into space
const NEAR = 3, DEPTH = 13;  // nearest distance, depth range (world units)
const BG = new THREE.Color(0, 0, 0);

/* ------------------------------------------------------------------ shaders */

const cloudVert = /* glsl */ `
  attribute vec3 aFlat, aNormal;
  attribute float aSize, aRand, aNear, aShade;
  attribute vec2 aUv;
  uniform float uTime, uGather, uDepth, uProj, uLevel, uScan, uScanOn;
  uniform vec3 uLight;
  varying vec3 vColor;
  varying float vFog;
  float h(float n) { return fract(sin(n) * 43758.5453123); }
  void main() {
    // 1 — dust gathers into the flat photograph
    float g = smoothstep(0.0, 1.0, clamp(uGather * 1.6 - aRand * 0.6, 0.0, 1.0));
    vec3 scat = aFlat * 1.3 + (vec3(h(aRand * 91.7), h(aRand * 13.3), h(aRand * 57.1)) - 0.5) * vec3(30.0, 20.0, 30.0);
    vec3 p = mix(scat, aFlat, g);
    // 2 — the photograph swells into a volume, nearest things first
    float d = smoothstep(0.0, 1.0, clamp(uDepth * 1.5 - (1.0 - aNear) * 0.5, 0.0, 1.0));
    p = mix(p, position, d);

    p += aNormal * sin(uTime * 1.3 + aRand * 30.0) * (0.004 + uLevel * 0.03) * d;
    float s = aUv.x - uScan;
    float sc = exp(-s * s * 1600.0) * uScanOn;
    p += aNormal * sc * 0.08;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float z = max(-mv.z, 0.05);
    gl_PointSize = clamp(aSize * uProj / z * (1.0 + sc * 0.6), 0.0, 36.0);
    gl_Position = projectionMatrix * mv;

    // light: key light orbits slowly, so the relief keeps catching it
    vec3 n = normalize(aNormal);
    float diff = max(dot(n, uLight), 0.0);
    vec3 viewDir = normalize(cameraPosition - p);
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
    float lit = mix(1.0, 0.72 + 0.6 * diff + 0.35 * rim, d);
    float tw = 0.9 + 0.1 * sin(uTime * (1.0 + aRand * 2.0) + aRand * 60.0);
    vColor = color * aShade * lit * tw * (1.0 + uLevel * 0.25) + sc * (0.25 + color * 1.5);
    vFog = smoothstep(26.0, 60.0, length(mv.xyz));
  }
`;
const cloudFrag = /* glsl */ `
  uniform vec3 uBg;
  varying vec3 vColor;
  varying float vFog;
  void main() { gl_FragColor = vec4(mix(vColor, uBg, vFog), 1.0); }
`;

const floorVert = /* glsl */ `
  attribute float aR;
  uniform float uProj, uDepth, uLevel;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(0.035 * uProj / max(-mv.z, 0.1), 0.0, 4.0);
    gl_Position = projectionMatrix * mv;
    vA = (1.0 - smoothstep(0.35, 1.0, aR)) * uDepth * (0.22 + uLevel * 0.2);
  }
`;
const floorFrag = /* glsl */ `
  varying float vA;
  void main() { gl_FragColor = vec4(vec3(vA), 1.0); }
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
    vA = pulse * (0.35 + uLevel * 0.9) * (1.0 - smoothstep(20.0, 45.0, z));
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

/** separable box filter: 'min' or 'mean' over a (2r+1)² window */
function filter(src, w, h, r, mode) {
  const pass = (inp, horiz) => {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = mode === 'min' ? Infinity : 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = horiz ? Math.min(w - 1, Math.max(0, x + k)) : x;
        const yy = horiz ? y : Math.min(h - 1, Math.max(0, y + k));
        const v = inp[yy * w + xx];
        if (mode === 'min') { if (v < m) m = v; } else { m += v; c++; }
      }
      o[y * w + x] = mode === 'min' ? m : m / c;
    }
    return o;
  };
  return pass(pass(src, true), false);
}

function bilinear(dm, u, v) {
  const x = Math.min(dm.w - 1, Math.max(0, u * (dm.w - 1)));
  const y = Math.min(dm.h - 1, Math.max(0, v * (dm.h - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(dm.w - 1, x0 + 1), y1 = Math.min(dm.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, d = dm.data;
  const a = d[y0 * dm.w + x0] * (1 - fx) + d[y0 * dm.w + x1] * fx;
  const b = d[y1 * dm.w + x0] * (1 - fx) + d[y1 * dm.w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/* ------------------------------------------------------------------ world */

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 300);
    this.controls = new OrbitFly(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.set(new THREE.Vector3(0, 0, -10), 0, 0, 10);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.5, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.uniforms = {
      uTime: { value: 0 }, uGather: { value: 0 }, uDepth: { value: 0 }, uProj: { value: 500 },
      uLevel: { value: 0 }, uHigh: { value: 0 }, uScan: { value: -1 }, uScanOn: { value: 0 },
      uLight: { value: new THREE.Vector3(-0.5, 0.7, 0.5).normalize() }, uBg: { value: BG.clone() },
    };
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.motes = this.#makeMotes([[0.79, 0.71, 1], [0.56, 0.94, 1], [1, 1, 1]]);
    this.scene.add(this.motes);

    this.clock = new THREE.Clock();
    this.anim = null;
    this.audio = { level: 0, high: 0, scan: -1 };
    this.idle = 0;
    this.built = false;

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

  #makeMotes(palette, count = 700) {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 3 + Math.random() * 20, th = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(th) * r;
      pos[i * 3 + 1] = (Math.random() - 0.4) * 10;
      pos[i * 3 + 2] = Math.sin(th) * r - 9;
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

  #dist(n) { return NEAR + DEPTH * Math.pow(1 - Math.min(1, Math.max(0, n)), 1.3); }

  /**
   * Lift the photo into a solid volume.
   * Every pixel is a surface point; where something stands in front of something else,
   * the gap behind it is filled with points, so objects get thickness and sides.
   * @param {{w,h,data}} depth  0..1, 1 = nearest
   * @param {{w,h,rgb}} grid    pixel colours
   * @returns number of points
   */
  build({ depth, points: grid }) {
    this.clear(false);
    const { w, h, rgb } = grid;
    const n = w * h;
    const tanH = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const aspect = w / h;

    // depth on the pixel grid
    const near = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) near[y * w + x] = bilinear(depth, (x + 0.5) / w, (y + 0.5) / h);
    const dist = near.map((v) => this.#dist(v));
    // what lies behind each pixel: farthest surface in the neighbourhood
    const r = Math.max(3, Math.round(w / 45));
    const behind = filter(filter(near, w, h, r, 'min'), w, h, 2, 'mean').map((v) => this.#dist(v));

    const ray = (x, y, d, out) => {
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      out[0] = (u - 0.5) * 2 * tanH * aspect * d;
      out[1] = (0.5 - v) * 2 * tanH * d;
      out[2] = -d;
      return out;
    };

    const P = [], F = [], C = [], N = [], S = [], R = [], NE = [], UV = [], SH = [];
    const sorted = Float32Array.from(dist).sort();
    const flatD = sorted[Math.floor(n * 0.5)];
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], e = [0, 0, 0], q = [0, 0, 0];
    const col = new THREE.Color();
    const nrm = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
    let minY = Infinity;

    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = dist[i];
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
      // surface normal from neighbouring points
      ray(xr, y, dist[y * w + xr], a); ray(xl, y, dist[y * w + xl], b);
      ray(x, yu, dist[yu * w + x], c); ray(x, yd, dist[yd * w + x], e);
      t1.set(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      t2.set(c[0] - e[0], c[1] - e[1], c[2] - e[2]);
      nrm.crossVectors(t1, t2).normalize();
      if (nrm.z < 0) nrm.negate();
      // outward side direction (towards the background) for the fill
      const gx = near[y * w + xr] - near[y * w + xl], gy = near[yu * w + x] - near[yd * w + x];
      const gl = Math.hypot(gx, gy) || 1;

      col.setRGB(rgb[i * 4] / 255, rgb[i * 4 + 1] / 255, rgb[i * 4 + 2] / 255).convertSRGBToLinear();
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      const spacing = (2 * tanH * d) / h;
      const rnd = Math.random();

      const push = (pd, normal, shade, sizeMul) => {
        ray(x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6, pd, q);
        P.push(q[0], q[1], q[2]);
        ray(x, y, flatD, q); F.push(q[0], q[1], q[2]);
        C.push(col.r, col.g, col.b);
        N.push(normal.x, normal.y, normal.z);
        S.push(spacing * sizeMul * (pd / d));
        R.push(Math.random());
        NE.push(near[i]); UV.push(u, v); SH.push(shade);
        if (q[1] < minY) minY = q[1];
      };

      push(d, nrm, 1, 0.62 + rnd * 0.35);

      // volume: fill the gap between this surface and what's behind it
      const gap = Math.min(behind[i] - d, d * 0.9);
      if (gap > spacing * 2) {
        const side = new THREE.Vector3(-gx / gl, -gy / gl, 0).lerp(nrm, 0.25).normalize();
        const count = Math.min(7, Math.ceil(gap / (spacing * 3)));
        for (let k = 1; k <= count; k++) {
          const f = k / (count + 0.5);
          push(d + gap * f * (0.8 + Math.random() * 0.25), side, 0.85 - f * 0.35, 0.6 + Math.random() * 0.35);
        }
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('aFlat', new THREE.Float32BufferAttribute(F, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setAttribute('aNormal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(S, 1));
    g.setAttribute('aRand', new THREE.Float32BufferAttribute(R, 1));
    g.setAttribute('aNear', new THREE.Float32BufferAttribute(NE, 1));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(UV, 2));
    g.setAttribute('aShade', new THREE.Float32BufferAttribute(SH, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: cloudVert, fragmentShader: cloudFrag, uniforms: this.uniforms, vertexColors: true });
    const cloud = new THREE.Points(g, m);
    cloud.frustumCulled = false;
    this.group.add(cloud);

    // pivot = middle of the volume; a faint dotted floor anchors it as an object
    this.center = new THREE.Vector3(0, 0, -flatD);
    this.flatD = flatD;
    this.halfW = tanH * aspect * flatD;
    this.halfH = tanH * flatD;
    this.group.add(this.#floor(this.center, minY, NEAR + DEPTH));
    this.built = true;
    return R.length;
  }

  #floor(center, y, radius) {
    const pos = [], rr = [];
    const step = radius / 34;
    for (let x = -radius; x <= radius; x += step) for (let z = -radius; z <= radius; z += step) {
      const r = Math.hypot(x, z) / radius;
      if (r > 1) continue;
      pos.push(center.x + x, y - 0.05, center.z + z); rr.push(r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aR', new THREE.Float32BufferAttribute(rr, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: floorVert, fragmentShader: floorFrag, uniforms: this.uniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  /** camera distance that frames the whole piece on this screen */
  #fit() {
    const tv = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const th = tv * this.camera.aspect;
    return Math.max(this.flatD, Math.max(this.halfW / th, this.halfH / tv) * 1.05);
  }

  /** gather → swell into volume → swing round so you see it's solid */
  dive(onUnfold) {
    this.controls.enabled = false;
    this.controls.sway = 0;
    this.controls.set(this.center, 0, 0, this.#fit()); // straight on: it starts as the photograph
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
    this.built = false;
    this.anim = null;
    if (resetCamera) {
      this.controls.enabled = false;
      this.controls.set(new THREE.Vector3(0, 0, -10), 0, 0, 10);
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
    const lt = U.uTime.value * 0.12;
    U.uLight.value.set(Math.sin(lt) * 0.8, 0.65, 0.45 + Math.cos(lt) * 0.35).normalize();

    const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    const io = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    const C = this.controls;
    if (this.anim) {
      const a = this.anim;
      a.t += Math.min(raw, 0.25); // wall-clock, so slow devices never stall the intro
      U.uGather.value = ease(a.t / 2.2);
      const unfold = (a.t - 2.4) / 3.0;
      U.uDepth.value = ease(unfold);
      if (unfold > 0 && !a.fired) { a.fired = true; a.onUnfold?.(); }
      // swing out to a three-quarter view, then settle a little closer
      const out = io((a.t - 3.4) / 3.2), back = io((a.t - 6.6) / 2.4);
      C.theta = 0.75 * out - 0.3 * back;
      C.phi = 0.32 * out - 0.12 * back;
      const fit = this.#fit();
      C.radius = fit * (1 + 0.15 * out - 0.35 * back);
      C.sway = back;
      if (a.t > 9.2) { this.anim = null; C.enabled = true; C.sway = 1; }
    } else if (!this.built) {
      this.idle += dt * 0.05;
      C.theta = Math.sin(this.idle) * 0.25;
    }

    C.update(dt);
    this.composer.render();
  }
}
