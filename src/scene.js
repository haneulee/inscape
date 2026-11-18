import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FlyControls } from './controls.js';

const FOV = 60;
const WORLD = 2.6; // metres per depth unit
const BG = new THREE.Color(0, 0, 0);

const cloudVert = /* glsl */ `
  attribute vec3 aFlat;
  attribute float aSize;
  attribute float aRand;
  attribute float aNear;
  attribute vec2 aUv;
  uniform float uTime, uGather, uDepth, uProj, uLevel, uScan, uScanOn;
  varying vec3 vColor;
  varying float vFog;
  float h(float n) { return fract(sin(n) * 43758.5453123); }
  void main() {
    // 1 — scattered dust gathers into the flat photograph
    float g = smoothstep(0.0, 1.0, clamp(uGather * 1.6 - aRand * 0.6, 0.0, 1.0));
    vec3 scat = aFlat * 1.4 + (vec3(h(aRand * 91.7), h(aRand * 13.3), h(aRand * 57.1)) - 0.5) * vec3(40.0, 26.0, 40.0);
    vec3 p = mix(scat, aFlat, g);
    // 2 — the photograph unfolds into depth, near things first
    float d = smoothstep(0.0, 1.0, clamp(uDepth * 1.5 - (1.0 - aNear) * 0.5, 0.0, 1.0));
    p = mix(p, position, d);

    // breathing with the music
    float dist = length(position);
    p += vec3(sin(uTime * 0.7 + aRand * 40.0), cos(uTime * 0.9 + aRand * 30.0), sin(uTime * 0.5 + aRand * 20.0))
         * (0.004 + uLevel * 0.035) * dist * d;

    // the scanline the melody is reading
    float sx = aUv.x - uScan;
    float scan = exp(-sx * sx * 1600.0) * uScanOn;
    p.y += scan * 0.012 * dist * (0.5 + aRand);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float z = max(-mv.z, 0.05);
    gl_PointSize = clamp(aSize * uProj / z * (1.0 + scan * 0.8), 0.0, 30.0);
    gl_Position = projectionMatrix * mv;

    float tw = 0.88 + 0.12 * sin(uTime * (1.0 + aRand * 2.0) + aRand * 60.0);
    vColor = color * tw * (1.0 + uLevel * 0.25) + scan * (0.35 + color * 1.6);
    vFog = smoothstep(14.0, 46.0, z);
  }
`;

const cloudFrag = /* glsl */ `
  uniform vec3 uBg;
  varying vec3 vColor;
  varying float vFog;
  void main() {
    gl_FragColor = vec4(mix(vColor, uBg, vFog), 1.0);
  }
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
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    float a = smoothstep(0.5, 0.0, r);
    gl_FragColor = vec4(vColor * a * a * vA * 1.8, 1.0);
  }
`;

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 200);
    this.controls = new FlyControls(this.camera, canvas);
    this.controls.enabled = false;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.uniforms = {
      uTime: { value: 0 }, uGather: { value: 0 }, uDepth: { value: 0 }, uProj: { value: 500 },
      uLevel: { value: 0 }, uHigh: { value: 0 }, uScan: { value: -1 }, uScanOn: { value: 0 },
      uBg: { value: BG.clone() },
    };

    this.cloud = null;
    this.motes = this.#makeMotes([[0.79, 0.71, 1], [0.56, 0.94, 1], [1, 1, 1]]);
    this.scene.add(this.motes);

    this.clock = new THREE.Clock();
    this.anim = null;
    this.audio = { level: 0, high: 0, scan: -1 };
    this.idleSpin = 0;

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
      const r = 3 + Math.random() * 24, th = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(th) * r;
      pos[i * 3 + 1] = (Math.random() - 0.35) * 10;
      pos[i * 3 + 2] = -Math.abs(Math.sin(th) * r) - 1;
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

  /**
   * grid: { w, h, rgb: Uint8ClampedArray (RGBA) }
   * depth: Float32Array w*h in 0..1, 1 = nearest
   */
  build(grid, depth) {
    if (this.cloud) { this.scene.remove(this.cloud); this.cloud.geometry.dispose(); }
    const { w, h, rgb } = grid;
    const n = w * h;
    const pos = new Float32Array(n * 3), flat = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const size = new Float32Array(n), rnd = new Float32Array(n), near = new Float32Array(n), uv = new Float32Array(n * 2);
    const tanH = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const aspect = w / h;
    // flat picture sits at the median distance
    const sorted = Float32Array.from(depth).sort();
    const flatDist = this.#dist(sorted[Math.floor(n * 0.5)]);
    const c = new THREE.Color();

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const u = (x + 0.5) / w, v = (y + 0.5) / h;
        const jitter = (Math.random() - 0.5) * 0.04;
        const dn = Math.min(1, Math.max(0, depth[i] + jitter * 0.3));
        const dist = this.#dist(dn) * (1 + jitter);
        const rx = (u - 0.5) * 2 * tanH * aspect;
        const ry = (0.5 - v) * 2 * tanH;
        pos[i * 3] = rx * dist; pos[i * 3 + 1] = ry * dist; pos[i * 3 + 2] = -dist;
        flat[i * 3] = rx * flatDist; flat[i * 3 + 1] = ry * flatDist; flat[i * 3 + 2] = -flatDist;
        c.setRGB(rgb[i * 4] / 255, rgb[i * 4 + 1] / 255, rgb[i * 4 + 2] / 255).convertSRGBToLinear();
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        const spacing = (2 * tanH * dist) / h;
        size[i] = spacing * (0.72 + Math.random() * 0.5);
        rnd[i] = Math.random();
        near[i] = dn;
        uv[i * 2] = u; uv[i * 2 + 1] = v;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aFlat', new THREE.BufferAttribute(flat, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    g.setAttribute('aNear', new THREE.BufferAttribute(near, 1));
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    const m = new THREE.ShaderMaterial({
      vertexShader: cloudVert, fragmentShader: cloudFrag, uniforms: this.uniforms, vertexColors: true,
    });
    this.cloud = new THREE.Points(g, m);
    this.cloud.frustumCulled = false;
    this.scene.add(this.cloud);
    this.flatDist = flatDist;
  }

  #dist(near01) {
    // inverse-depth → metric-ish distance (1 … ~11 units) × WORLD
    return WORLD / (0.09 + 0.91 * Math.pow(near01, 1.15));
  }

  /** gather → unfold → glide in. onUnfold fires when the photo starts becoming space. */
  dive(onUnfold) {
    this.controls.enabled = false;
    this.controls.reset(new THREE.Vector3(0, 0, 0), 0, 0);
    this.uniforms.uGather.value = 0;
    this.uniforms.uDepth.value = 0;
    this.anim = { t: 0, fired: false, onUnfold };
  }

  clear() {
    if (this.cloud) { this.scene.remove(this.cloud); this.cloud.geometry.dispose(); this.cloud = null; }
    this.anim = null;
    this.controls.enabled = false;
    this.controls.reset(new THREE.Vector3(0, 0, 0), 0, 0);
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

    if (this.anim) {
      const a = this.anim;
      a.t += Math.min(raw, 0.25); // wall-clock, so slow devices never stall the intro
      const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
      U.uGather.value = ease(a.t / 2.2);
      const unfold = (a.t - 2.4) / 3.2;
      U.uDepth.value = ease(unfold);
      if (unfold > 0 && !a.fired) { a.fired = true; a.onUnfold?.(); }
      // glide into the picture
      const k = ease((a.t - 2.6) / 4.2);
      const s = Math.sin(k * Math.PI);
      this.camera.position.set(s * 0.35, -0.12 * k, -1.6 * k);
      this.controls.yaw = -s * 0.06;
      this.controls.pitch = -0.02 * k;
      this.controls.applyRotation();
      if (a.t > 6.9) {
        this.anim = null;
        this.controls.enabled = true;
      }
    } else if (!this.cloud) {
      // landing: slow drift through the motes
      this.idleSpin += dt * 0.02;
      this.controls.yaw = Math.sin(this.idleSpin) * 0.25;
      this.controls.applyRotation();
    }

    this.controls.update(dt);
    this.composer.render();
  }
}
