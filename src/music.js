// Image → music.
// The photo is read like a score: left → right is time, height is pitch,
// colour picks the key and mode, contrast drives rhythm, pixel count sets the length.

const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const MODES = [
  ['aeolian', [0, 2, 3, 5, 7, 8, 10]],
  ['dorian', [0, 2, 3, 5, 7, 9, 10]],
  ['mixolydian', [0, 2, 4, 5, 7, 9, 10]],
  ['ionian', [0, 2, 4, 5, 7, 9, 11]],
  ['lydian', [0, 2, 4, 6, 7, 9, 11]],
];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1e6) / 1e6;
  };
}

function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Analyse a small RGBA grid of the photo. */
export function analyze({ w, h, rgb }, origW, origH) {
  const n = w * h;
  const L = new Float32Array(n), S = new Float32Array(n), H = new Float32Array(n);
  let sumL = 0, sumS = 0, warm = 0, hash = 2166136261;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 4], g = rgb[i * 4 + 1], b = rgb[i * 4 + 2];
    const [hh, ss, ll] = hsl(r, g, b);
    H[i] = hh; S[i] = ss; L[i] = ll;
    sumL += ll; sumS += ss; warm += (r - b) / 255;
    hash = Math.imul(hash ^ (r + g * 3 + b * 7), 16777619);
  }
  const meanL = sumL / n, meanS = sumS / n;
  let varL = 0, edge = 0, bright = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    varL += (L[i] - meanL) ** 2;
    if (x < w - 1) edge += Math.abs(L[i] - L[i + 1]);
    if (y < h - 1) edge += Math.abs(L[i] - L[i + w]);
    if (L[i] > 0.72) bright++;
  }
  const contrast = Math.sqrt(varL / n);
  const edges = edge / (2 * n);
  const palette = kmeans(rgb, n, 5, rng(hash));

  return {
    w, h, L, S, H,
    origW, origH, pixels: origW * origH,
    meanL, meanS, warmth: warm / n, contrast, edges, brightRatio: bright / n,
    palette, seed: hash >>> 0,
  };
}

function kmeans(rgb, n, k, rand) {
  const step = Math.max(1, Math.floor(n / 2500));
  const pts = [];
  for (let i = 0; i < n; i += step) pts.push([rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2]]);
  let cs = Array.from({ length: k }, () => pts[Math.floor(rand() * pts.length)].slice());
  let counts = new Array(k).fill(0);
  for (let it = 0; it < 10; it++) {
    const acc = cs.map(() => [0, 0, 0]);
    counts = new Array(k).fill(0);
    for (const p of pts) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (p[0] - cs[c][0]) ** 2 + (p[1] - cs[c][1]) ** 2 + (p[2] - cs[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      counts[best]++;
      acc[best][0] += p[0]; acc[best][1] += p[1]; acc[best][2] += p[2];
    }
    cs = cs.map((c, i) => (counts[i] ? acc[i].map((v) => v / counts[i]) : pts[Math.floor(rand() * pts.length)].slice()));
  }
  return cs
    .map((c, i) => ({ rgb: c.map(Math.round), weight: counts[i] / pts.length, hsl: hsl(...c) }))
    .sort((a, b) => b.weight - a.weight);
}

/** Turn the analysis into a score (list of note events). */
export function compose(a) {
  const rand = rng(a.seed ^ 0x9e3779b9);

  // key: the most vivid dominant colour → pitch class (hue walks the circle of fifths)
  const keyColor = [...a.palette].sort((p, q) => q.weight * (0.2 + q.hsl[1]) - p.weight * (0.2 + p.hsl[1]))[0];
  const pc = (Math.round(keyColor.hsl[0] / 30) * 7) % 12;
  // mode: brightness + warmth → dark (aeolian) … luminous (lydian)
  const moodScore = clamp(a.meanL * 0.65 + clamp(a.warmth * 1.5 + 0.5, 0, 1) * 0.35, 0, 0.999);
  const [modeName, scale] = MODES[Math.floor(moodScore * MODES.length)];
  // tempo: saturation + contrast
  const bpm = Math.round(clamp(62 + a.meanS * 30 + a.contrast * 70, 60, 112));
  // length: more pixels → longer piece
  const mp = a.pixels / 1e6;
  const bars = clamp(16 + 4 * Math.round(Math.log2(1 + mp)), 16, 32);

  const beat = 60 / bpm, bar = beat * 4;
  const tonic = 48 + pc; // C3…B3
  const deg2midi = (deg, base) => base + 12 * Math.floor(deg / 7) + scale[((deg % 7) + 7) % 7];

  // chord progression from the palette hues
  const prog = [0];
  for (const p of a.palette.slice(1, 4)) {
    let d = Math.floor((p.hsl[0] / 360) * 7) % 7;
    if (d === prog[prog.length - 1]) d = (d + 3) % 7;
    // avoid diminished triads
    const fifth = deg2midi(d + 4, 0) - deg2midi(d, 0);
    if (fifth !== 7) d = (d + 4) % 7;
    prog.push(d);
  }
  while (prog.length < 4) prog.push((prog[prog.length - 1] + 3) % 7);

  const notes = []; // {t, dur, midi, vel, inst, pan}
  const intro = 2, outro = 2;

  // pads + bass
  for (let b = 0; b < bars; b++) {
    const deg = b >= bars - outro ? 0 : prog[b % 4];
    const t = b * bar;
    const swell = b < intro ? 0.55 + 0.45 * (b / intro) : 1;
    for (const k of [0, 2, 4, 6]) {
      notes.push({ inst: 'pad', t, dur: bar + 0.4, midi: deg2midi(deg + k, tonic), vel: 0.16 * swell * (k === 6 ? 0.6 : 1), pan: (k / 6 - 0.5) * 0.6 });
    }
    if (b >= intro && b < bars - outro) {
      const root = deg2midi(deg, tonic - 12);
      notes.push({ inst: 'bass', t, dur: beat * 2.2, midi: root, vel: 0.5, pan: 0 });
      notes.push({ inst: 'bass', t: t + beat * 2, dur: beat * 1.8, midi: a.contrast > 0.2 ? root + 7 : root, vel: 0.38, pan: 0 });
    }
  }

  // melody: scan the picture column by column
  const mStart = intro * bar, mBars = bars - intro - outro;
  const steps = mBars * 8; // eighth notes
  const mBase = tonic + 12;
  const restBase = 0.18 + (1 - clamp(a.edges * 8, 0, 1)) * 0.3;
  let prev = 7;
  const melody = [];
  for (let s = 0; s < steps; s++) {
    const col = Math.min(a.w - 1, Math.floor((s / steps) * a.w));
    // most salient pixel in the column
    let best = 0, bestScore = -1, colMean = 0, colVar = 0;
    for (let y = 0; y < a.h; y++) colMean += a.L[y * a.w + col];
    colMean /= a.h;
    for (let y = 0; y < a.h; y++) {
      const i = y * a.w + col;
      colVar += (a.L[i] - colMean) ** 2;
      const score = Math.abs(a.L[i] - colMean) + a.S[i] * 0.45 + (1 - y / a.h) * 0.05;
      if (score > bestScore) { bestScore = score; best = y; }
    }
    const lum = a.L[best * a.w + col];
    const colContrast = Math.sqrt(colVar / a.h);
    const onBar = s % 8 === 0;
    if (!onBar && (rand() < restBase + (0.25 - colContrast) * 0.6 || lum < 0.06)) continue;

    let deg = Math.round((1 - best / a.h) * 11);
    deg = prev + clamp(deg - prev, -4, 4); // keep it singable
    const chord = prog[Math.floor(s / 8) % 4];
    if (s % 4 === 0) {
      // strong beats land on chord tones
      const tones = [chord, chord + 2, chord + 4, chord + 7, chord + 9, chord + 11].filter((t) => t <= 13);
      deg = tones.reduce((p, c) => (Math.abs(c - deg) < Math.abs(p - deg) ? c : p));
    }
    prev = deg;
    const half = s / steps > 0.5 ? 12 : 0; // second half lifts an octave in bright images
    melody.push({
      inst: 'bell', t: mStart + s * (beat / 2), step: s,
      midi: deg2midi(deg, mBase) + (a.meanL > 0.45 && deg <= 7 ? half : 0),
      vel: 0.18 + 0.32 * lum, pan: (col / a.w - 0.5) * 1.2, col: col / a.w,
    });
  }
  for (let i = 0; i < melody.length; i++) {
    const gap = (melody[i + 1]?.step ?? melody[i].step + 3) - melody[i].step;
    melody[i].dur = Math.min(gap, 4) * (beat / 2) * 0.95;
    notes.push(melody[i]);
  }

  // sparkles from the brightest pixels
  for (let b = intro; b < bars - outro; b++) {
    const count = Math.round(a.brightRatio * 6 + rand() * 1.2);
    for (let j = 0; j < count; j++) {
      const deg = prog[b % 4] + [0, 2, 4][Math.floor(rand() * 3)] + 7;
      notes.push({ inst: 'glass', t: b * bar + Math.floor(rand() * 16) * (beat / 4), dur: 1.5, midi: deg2midi(deg, mBase), vel: 0.06 + rand() * 0.05, pan: rand() * 1.6 - 0.8 });
    }
  }

  // soft pulse when the image has bite
  if (a.contrast > 0.12) {
    for (let b = intro; b < bars - outro; b++) {
      notes.push({ inst: 'kick', t: b * bar, vel: 0.35 + a.contrast * 0.6 });
      if (a.contrast > 0.2) notes.push({ inst: 'kick', t: b * bar + beat * 2.5, vel: 0.22 });
      for (let e = 1; e < 8; e += 2) notes.push({ inst: 'shaker', t: b * bar + e * (beat / 2), vel: 0.02 + a.contrast * 0.06 + (e === 5 ? 0.01 : 0) });
    }
  }

  // final chord bell
  notes.push({ inst: 'bell', t: (bars - outro) * bar, dur: 3, midi: tonic + 24, vel: 0.35, pan: 0 });

  return {
    notes, bpm, bars, beat, bar,
    key: `${NOTE[pc]} ${modeName}`,
    melodyStart: mStart, melodyEnd: (bars - outro) * bar,
    duration: bars * bar + 5,
    warm: a.warmth > 0,
    filter: 500 + a.meanL * 2200,
  };
}

/** Render the score offline into an AudioBuffer. */
export async function render(score, sampleRate = 44100) {
  const ctx = new OfflineAudioContext(2, Math.ceil(score.duration * sampleRate), sampleRate);

  const master = ctx.createGain(); master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.3;
  master.connect(comp).connect(ctx.destination);

  const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 4.5);
  const verbIn = ctx.createGain(); verbIn.gain.value = 0.55;
  verbIn.connect(verb).connect(master);

  const delay = ctx.createDelay(2); delay.delayTime.value = score.beat * 0.75;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2800;
  const delayIn = ctx.createGain(); delayIn.gain.value = 0.28;
  delayIn.connect(delay).connect(dlp).connect(fb).connect(delay);
  dlp.connect(master); dlp.connect(verbIn);

  const noise = ctx.createBuffer(1, sampleRate, sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const bus = (pan, send = 0.5, echo = 0) => {
    const p = ctx.createStereoPanner(); p.pan.value = pan || 0;
    p.connect(master);
    const s = ctx.createGain(); s.gain.value = send; p.connect(s).connect(verbIn);
    if (echo) { const e = ctx.createGain(); e.gain.value = echo; p.connect(e).connect(delayIn); }
    return p;
  };

  for (const n of score.notes) {
    const t = n.t;
    if (n.inst === 'pad') {
      const out = bus(n.pan, 0.9);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.4;
      f.frequency.setValueAtTime(score.filter * 0.5, t);
      f.frequency.linearRampToValueAtTime(score.filter, t + n.dur * 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(n.vel, t + 1.2);
      g.gain.setValueAtTime(n.vel, t + n.dur - 0.3);
      g.gain.linearRampToValueAtTime(0, t + n.dur + 1.4);
      f.connect(g).connect(out);
      for (const [type, det] of [['sawtooth', -7], ['sawtooth', 7], ['triangle', 0]]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = mtof(n.midi); o.detune.value = det;
        const og = ctx.createGain(); og.gain.value = type === 'triangle' ? 0.6 : 0.3;
        o.connect(og).connect(f); o.start(t); o.stop(t + n.dur + 1.5);
      }
    } else if (n.inst === 'bass') {
      const out = bus(0, 0.1);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
      const g = env(ctx, t, 0.02, n.dur, n.vel, 0.25);
      f.connect(g).connect(out);
      for (const [type, mul] of [['sine', 1], ['triangle', 0.5]]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = mtof(n.midi) * mul;
        o.connect(f); o.start(t); o.stop(t + n.dur + 0.4);
      }
    } else if (n.inst === 'bell' || n.inst === 'glass') {
      const out = bus(n.pan, n.inst === 'glass' ? 0.9 : 0.45, n.inst === 'bell' ? 1 : 0);
      const fq = mtof(n.midi);
      const ratio = n.inst === 'glass' ? 3.5 : score.warm ? 2 : 3.01;
      const car = ctx.createOscillator(); car.frequency.value = fq;
      const mod = ctx.createOscillator(); mod.frequency.value = fq * ratio;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(fq * (n.inst === 'glass' ? 0.8 : 1.6), t);
      mg.gain.exponentialRampToValueAtTime(fq * 0.05, t + 0.9);
      mod.connect(mg).connect(car.frequency);
      const decay = n.inst === 'glass' ? 1.6 : Math.max(0.6, n.dur * 1.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(n.vel, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      car.connect(g).connect(out);
      for (const o of [car, mod]) { o.start(t); o.stop(t + decay + 0.05); }
    } else if (n.inst === 'kick') {
      const out = bus(0, 0.08);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(n.vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(out); o.start(t); o.stop(t + 0.5);
    } else if (n.inst === 'shaker') {
      const out = bus(0.25, 0.3);
      const s = ctx.createBufferSource(); s.buffer = noise;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(n.vel, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
      s.connect(f).connect(g).connect(out); s.start(t, Math.random() * 0.8, 0.12);
    }
  }

  const buf = await ctx.startRendering();
  // normalise to -1 dBFS
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const gain = peak ? 0.89 / peak : 1;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
  }
  return buf;
}

function env(ctx, t, atk, dur, vel, rel) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + atk);
  g.gain.setValueAtTime(vel, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + rel);
  return g;
}

function impulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return b;
}

/** 16-bit PCM WAV */
export function toWav(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, data[c][i]));
    out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}
