import { World } from './scene.js';
import { estimateDepth } from './depth.js';
import { analyze, compose, render, toWav } from './music.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const num = (n) => n.toLocaleString('en-US');
const isMobile = matchMedia('(max-width: 640px), (pointer: coarse)').matches;

const world = new World($('world'));
world.controls.onMove = () => body.classList.add('moved');
if (location.hostname === 'localhost') window.__inscape = { world, get player() { return player; } };

/* ---------------- audio player ---------------- */
class Player {
  ctx = null; buffer = null; src = null; offset = 0; startedAt = 0; playing = false; loop = true;
  onchange = () => {};

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.82;
      this.analyser.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    }
    return this.ctx.resume().catch(() => {});
  }
  load(buffer) { this.stop(); this.buffer = buffer; this.offset = 0; this.onchange(); }
  get duration() { return this.buffer?.duration ?? 0; }
  get time() { return this.playing ? Math.min(this.ctx.currentTime - this.startedAt, this.duration) : this.offset; }

  play() {
    if (!this.buffer || this.playing) return;
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.analyser);
    src.start(0, this.offset);
    this.startedAt = this.ctx.currentTime - this.offset;
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null; this.playing = false; this.offset = 0;
      if (this.loop) this.play(); else this.onchange();
    };
    this.src = src; this.playing = true;
    this.onchange();
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.time;
    this.#kill();
    this.onchange();
  }
  stop() { this.#kill(); this.offset = 0; this.onchange(); }
  seek(t) {
    const was = this.playing;
    this.#kill();
    this.offset = Math.max(0, Math.min(t, this.duration));
    if (was) this.play(); else this.onchange();
  }
  #kill() {
    if (this.src) { const s = this.src; this.src = null; s.onended = null; try { s.stop(); } catch {} }
    this.playing = false;
  }
  levels() {
    if (!this.analyser || !this.playing) return { level: 0, high: 0 };
    this.analyser.getByteFrequencyData(this.freq);
    let lo = 0, hi = 0;
    for (let i = 1; i < 14; i++) lo += this.freq[i];
    for (let i = 60; i < 180; i++) hi += this.freq[i];
    return { level: lo / (13 * 255), high: hi / (120 * 255) };
  }
}
const player = new Player();

/* ---------------- waveform seek bar ---------------- */
const wave = $('wave');
const wctx = wave.getContext('2d');
let peaks = [];
function computePeaks(buf) {
  const n = 160, d0 = buf.getChannelData(0), d1 = buf.getChannelData(buf.numberOfChannels - 1);
  const per = Math.floor(d0.length / n);
  peaks = Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (let j = i * per; j < (i + 1) * per; j += 32) s += Math.abs(d0[j]) + Math.abs(d1[j]);
    return s / (per / 32) / 2;
  });
  const mx = Math.max(...peaks) || 1;
  peaks = peaks.map((p) => Math.pow(p / mx, 0.7));
}
function drawWave() {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = wave.clientWidth, h = wave.clientHeight;
  if (wave.width !== w * dpr) { wave.width = w * dpr; wave.height = h * dpr; }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);
  if (!peaks.length) return;
  const step = 3, bars = Math.floor(w / step);
  const prog = player.duration ? player.time / player.duration : 0;
  for (let i = 0; i < bars; i++) {
    const p = peaks[Math.floor((i / bars) * peaks.length)];
    const bh = Math.max(1, Math.round(p * (h - 4)));
    const played = i / bars < prog;
    wctx.fillStyle = played ? 'rgba(236,235,242,0.95)' : 'rgba(236,235,242,0.2)';
    wctx.fillRect(i * step, Math.round((h - bh) / 2), 2, bh);
  }
}
function seekFromEvent(e) {
  const r = wave.getBoundingClientRect();
  player.seek(((e.clientX - r.left) / r.width) * player.duration);
}
wave.addEventListener('pointerdown', (e) => {
  wave.setPointerCapture(e.pointerId);
  seekFromEvent(e);
  const move = (ev) => seekFromEvent(ev);
  wave.addEventListener('pointermove', move);
  wave.addEventListener('pointerup', () => wave.removeEventListener('pointermove', move), { once: true });
});

/* ---------------- controls ---------------- */
const playerEl = $('player');
player.onchange = () => {
  playerEl.classList.toggle('playing', player.playing);
  $('playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
};
$('playBtn').onclick = async () => {
  await player.ensure();
  player.playing ? player.pause() : player.play();
};
$('loopBtn').onclick = (e) => {
  player.loop = !player.loop;
  e.currentTarget.setAttribute('aria-pressed', String(player.loop));
};
let current = null; // { name, score, wavUrl }
$('dlBtn').onclick = () => {
  if (!player.buffer || !current) return;
  if (!current.wavUrl) current.wavUrl = URL.createObjectURL(toWav(player.buffer));
  const a = document.createElement('a');
  a.href = current.wavUrl;
  a.download = `inscape-${current.name}-${current.score.key.replace(/\s+/g, '-').replace('♯', 's')}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
};
window.addEventListener('keydown', (e) => {
  if (body.dataset.state !== 'scene') return;
  if (e.code === 'KeyP' || e.code === 'KeyM') $('playBtn').click();
});
$('newBtn').onclick = () => {
  player.stop();
  world.clear();
  body.dataset.state = 'idle';
  body.classList.remove('moved');
  $('file').value = '';
};

/* ---------------- input ---------------- */
$('file').addEventListener('change', (e) => e.target.files[0] && dive(e.target.files[0]));
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; body.classList.remove('dragging');
  const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (f) dive(f);
});
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (f) dive(f);
});

/* ---------------- loader log ---------------- */
const log = $('log');
function line(label, value = '') {
  const li = document.createElement('li');
  li.innerHTML = `<span></span><span></span>`;
  li.children[0].textContent = label; li.children[1].textContent = value;
  log.appendChild(li);
  while (log.children.length > 6) log.firstChild.remove();
  return (v) => { li.children[1].textContent = v; };
}
const progress = (p) => { $('barFill').style.width = `${Math.round(p * 100)}%`; };

/* ---------------- pipeline ---------------- */
let job = 0;
let waitingForGesture = false;

async function dive(file) {
  const id = ++job;
  player.ensure(); // unlock audio inside the user gesture
  player.stop();
  world.clear();
  body.dataset.state = 'loading';
  body.classList.remove('moved');
  log.innerHTML = ''; progress(0);

  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    line('could not read this image'); setTimeout(() => (body.dataset.state = 'idle'), 1800);
    return;
  }
  const name = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'image';
  line('reading', `${bmp.width} × ${bmp.height}`);
  progress(0.05);

  // pixel grid for the point cloud
  const aspect = bmp.width / bmp.height;
  // surface pixels; the volume fill adds more points behind foreground objects
  const target = isMobile ? 45000 : 110000;
  const gw = Math.round(Math.sqrt(target * aspect)), gh = Math.round(gw / aspect);
  const grid = rasterize(bmp, gw, gh);
  const dW = 320, depthGrid = rasterize(bmp, dW, Math.max(16, Math.round(dW / aspect)));
  line('pixelating', `${num(gw * gh)} pixels`);

  // small grid for the music
  const mw = 96, mh = Math.max(24, Math.round(mw / aspect));
  const analysis = analyze(rasterize(bmp, mw, mh), bmp.width, bmp.height);
  const score = compose(analysis);
  world.setPalette(analysis.palette.map((p) => p.rgb));
  line('listening', `${score.key} · ${score.bpm} bpm`);
  progress(0.12);

  // depth + audio in parallel
  const src = document.createElement('canvas');
  const sw = Math.min(640, bmp.width), sh = Math.round(sw / aspect);
  src.width = sw; src.height = sh;
  src.getContext('2d').drawImage(bmp, 0, 0, sw, sh);

  const setDepth = line('estimating depth', '…');
  const setSong = line('composing', '…');
  let dp = 0, ap = 0;
  const tick = () => progress(0.12 + dp * 0.68 + ap * 0.2);
  const depthP = estimateDepth(src, depthGrid, (p) => { dp = p * 0.9; setDepth(`model ${Math.round(p * 100)}%`); tick(); })
    .then((r) => { dp = 1; setDepth(r.method); tick(); return r; });
  const songP = render(score).then((b) => { ap = 1; setSong(`${num(score.notes.length)} notes`); tick(); return b; });
  const [{ depth, method }, buffer] = await Promise.all([depthP, songP]);
  if (id !== job) return;

  line('stepping in', '');
  progress(1);
  const pointCount = world.build({ depth: { w: depthGrid.w, h: depthGrid.h, data: depth }, points: grid });
  player.load(buffer);
  computePeaks(buffer);
  $('tDur').textContent = fmt(buffer.duration);
  current = { name, score, wavUrl: null };
  fillReadout(bmp, pointCount, method, score, analysis);
  bmp.close?.();

  await new Promise((r) => setTimeout(r, 450));
  if (id !== job) return;
  body.dataset.state = 'scene';
  world.dive(() => {
    if (id !== job) return;
    if (player.ctx.state === 'running') player.play();
    else waitingForGesture = true; // autoplay blocked — first touch starts the music
  });
}

window.addEventListener('pointerdown', async (e) => {
  if (!waitingForGesture) return;
  waitingForGesture = false;
  if (e.target.closest?.('#player')) return; // the play button handles itself
  await player.ensure();
  player.play();
}, true);

function rasterize(bmp, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, 0, w, h);
  return { w, h, rgb: x.getImageData(0, 0, w, h).data };
}

function fillReadout(bmp, points, method, score, a) {
  const rows = [
    ['source', `${bmp.width} × ${bmp.height}`],
    ['pixels', num(a.pixels)],
    ['points', num(points)],
    ['depth', method],
    ['key', score.key],
    ['tempo', `${score.bpm} bpm · ${score.bars} bars`],
    ['notes', num(score.notes.length)],
  ];
  const el = $('readout');
  el.innerHTML = '';
  for (const [k, v] of rows) {
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = '<span class="k"></span><span></span>';
    r.children[0].textContent = k; r.children[1].textContent = v;
    el.appendChild(r);
  }
  const sw = document.createElement('div'); sw.className = 'sw';
  for (const p of a.palette) {
    const i = document.createElement('i');
    i.style.background = `rgb(${p.rgb.join(',')})`;
    i.style.width = `${8 + Math.round(p.weight * 40)}px`;
    sw.appendChild(i);
  }
  el.appendChild(sw);
}

/* ---------------- frame sync: audio → visuals ---------------- */
function frame() {
  if (body.dataset.state === 'scene' && player.buffer) {
    const t = player.time;
    $('tCur').textContent = fmt(t);
    const { level, high } = player.levels();
    const s = current?.score;
    const scan = s && player.playing && t >= s.melodyStart && t <= s.melodyEnd
      ? (t - s.melodyStart) / (s.melodyEnd - s.melodyStart) : -1;
    world.audio = { level, high, scan };
    drawWave();
  } else {
    world.audio = { level: 0, high: 0, scan: -1 };
  }
  requestAnimationFrame(frame);
}
frame();
