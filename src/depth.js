// Monocular depth estimation in the browser (Depth Anything V2, via transformers.js).
// Falls back to a hand-made heuristic if the model can't load.

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const MODEL = 'onnx-community/depth-anything-v2-small';

let estimatorPromise = null;

function loadEstimator(onProgress) {
  if (!estimatorPromise) {
    estimatorPromise = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS);
      env.allowLocalModels = false;
      const files = new Map();
      return pipeline('depth-estimation', MODEL, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            let l = 0, t = 0;
            for (const [a, b] of files.values()) { l += a; t += b; }
            onProgress?.(l / t);
          }
        },
      });
    })();
    estimatorPromise.catch(() => { estimatorPromise = null; });
  }
  return estimatorPromise;
}

/**
 * @param {HTMLCanvasElement} source small canvas of the photo (≤ 640px)
 * @param {{w:number,h:number,rgb:Uint8ClampedArray}} grid target sampling grid
 * @returns {Promise<{depth: Float32Array, method: string}>} 0..1 per grid cell, 1 = nearest
 */
export async function estimateDepth(source, grid, onProgress) {
  try {
    const estimator = await withTimeout(loadEstimator(onProgress), 90000);
    const out = await estimator(source.toDataURL('image/jpeg', 0.92));
    const img = out.depth; // RawImage, 1 channel, higher = nearer
    const raw = sample(img.data, img.width, img.height, img.channels || 1, grid.w, grid.h);
    return { depth: normalize(smooth(raw, grid.w, grid.h)), method: 'depth-anything v2' };
  } catch (err) {
    console.warn('[inscape] depth model unavailable, using heuristic', err);
    return { depth: heuristic(grid), method: 'luminance heuristic' };
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function sample(data, sw, sh, ch, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) / h) * sh));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) / w) * sw));
      out[y * w + x] = data[(sy * sw + sx) * ch];
    }
  }
  return out;
}

// light 3×3 blur to tame stair-stepping from the upsampled depth map
function smooth(d, w, h) {
  const o = new Float32Array(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const xx = x + i, yy = y + j;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      s += d[yy * w + xx]; n++;
    }
    o[y * w + x] = s / n;
  }
  return o;
}

function normalize(d) {
  // robust min/max (1st–99th percentile)
  const s = Float32Array.from(d).sort();
  const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.floor(s.length * 0.99)];
  const r = hi - lo || 1;
  const o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) o[i] = Math.min(1, Math.max(0, (d[i] - lo) / r));
  return o;
}

// Ground-plane + luminance guess: lower in frame = nearer, dark & saturated = nearer.
function heuristic({ w, h, rgb }) {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const r = rgb[i * 4] / 255, g = rgb[i * 4 + 1] / 255, b = rgb[i * 4 + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const v = y / h;
    const ground = Math.max(0, (v - 0.45) / 0.55);
    d[i] = ground * 0.75 + (1 - l) * 0.15 + (Math.max(r, g, b) - Math.min(r, g, b)) * 0.1;
  }
  return normalize(smooth(smooth(d, w, h), w, h));
}
