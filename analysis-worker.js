// BPM, clé et énergie estimés sur l'extrait 30 s (mono, 11025 Hz).
// Même méthode que analysis.py de la version Mac (profils de Temperley, 65-1000 Hz, correction d'accordage).
const SR = 11025;
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CAMELOT_MAJ = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MIN = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
const MAJOR = [5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4];
const MINOR = [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4];

const fftCache = {};
function fftTables(n) {
  if (fftCache[n]) return fftCache[n];
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  const hann = new Float64Array(n);
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));   // = numpy.hanning
  return (fftCache[n] = { rev, cos, sin, hann });
}

// |rfft(frame * hann)| -> Float64Array(n/2 + 1)
function magSpectrum(x, start, n) {
  const { rev, cos, sin, hann } = fftTables(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[rev[i]] = x[start + i] * hann[i];
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  const out = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

const frameCount = (len, n, hop) => Math.floor((len - n) / hop) + 1;

function estimateKey(x) {
  const n = 8192, hop = 1024, nf = frameCount(x.length, n, hop);
  const freqs = [], bins = [];
  for (let i = 0; i <= n / 2; i++) { const f = i * SR / n; if (f > 65 && f < 1000) { bins.push(i); freqs.push(f); } }
  const specs = []; let max = 0;
  for (let f = 0; f < nf; f++) {
    const m = magSpectrum(x, f * hop, n), row = new Float64Array(bins.length);
    for (let j = 0; j < bins.length; j++) { row[j] = m[bins[j]]; if (row[j] > max) max = row[j]; }
    specs.push(row);
  }
  const total = new Float64Array(bins.length);
  for (const row of specs) for (let j = 0; j < row.length; j++) { row[j] = Math.log1p(100 * row[j] / (max + 1e-9)); total[j] += row[j]; }
  let midi = freqs.map(f => 69 + 12 * Math.log2(f / 440));
  // accordage : certains morceaux ne sont pas pile à 440 Hz
  let sr = 0, si = 0;
  midi.forEach((m, j) => { const d = m - Math.round(m); sr += total[j] * Math.cos(2 * Math.PI * d); si += total[j] * Math.sin(2 * Math.PI * d); });
  const shift = Math.atan2(si, sr) / (2 * Math.PI);
  midi = midi.map(m => m - shift);
  const pc = midi.map(m => (Math.abs(m - Math.round(m)) < 0.3 ? ((Math.round(m) % 12) + 12) % 12 : -1));
  const chroma = new Float64Array(12);
  for (const row of specs) {
    const c = new Float64Array(12); let s = 0;
    for (let j = 0; j < row.length; j++) if (pc[j] >= 0) { c[pc[j]] += row[j]; s += row[j]; }
    for (let i = 0; i < 12; i++) chroma[i] += c[i] / (s + 1e-9);
  }
  const z = normalise(chroma);
  let best = null;
  for (let t = 0; t < 12; t++) for (const [mode, prof] of [["maj", MAJOR], ["min", MINOR]]) {
    const p = Array.from({ length: 12 }, (_, i) => prof[((i - t) % 12 + 12) % 12]);
    const r = pearson(z, p);
    if (!best || r > best.r) best = { r, t, mode };
  }
  return {
    key: NOTES[best.t] + (best.mode === "min" ? "m" : ""),
    camelot: (best.mode === "maj" ? CAMELOT_MAJ : CAMELOT_MIN)[best.t],
    key_conf: Math.round(best.r * 100) / 100,
  };
}

function normalise(a) {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  return Array.from(a, v => (v - m) / (sd + 1e-9));
}
function pearson(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
}

function spectralFlux(x, n, hop, logMag) {
  const nf = frameCount(x.length, n, hop), flux = new Float64Array(nf - 1);
  let prev = null;
  for (let f = 0; f < nf; f++) {
    const m = magSpectrum(x, f * hop, n);
    if (logMag) for (let i = 0; i < m.length; i++) m[i] = Math.log1p(m[i]);
    if (prev) { let s = 0; for (let i = 0; i < m.length; i++) { const d = m[i] - prev[i]; if (d > 0) s += d; } flux[f - 1] = s; }
    prev = m;
  }
  return flux;
}

function estimateBpm(x) {
  const hop = 256, raw = spectralFlux(x, 1024, hop, true), len = raw.length;
  const flux = new Float64Array(len);
  for (let i = 0; i < len; i++) {   // flux - moyenne glissante sur 16 trames (= np.convolve 'same'), puis >= 0
    let s = 0;
    for (let k = i - 8; k <= i + 7; k++) if (k >= 0 && k < len) s += raw[k];
    flux[i] = Math.max(0, raw[i] - s / 16);
  }
  const fps = SR / hop, maxLag = Math.ceil(4 * fps * 60 / 70) + 2;
  const ac = new Float64Array(maxLag + 1);
  for (let l = 0; l <= maxLag; l++) { let s = 0; for (let t = 0; t + l < len; t++) s += flux[t] * flux[t + l]; ac[l] = s; }
  const at = l => { const i = Math.floor(l), f = l - i; return i + 1 <= maxLag ? ac[i] * (1 - f) + ac[i + 1] * f : 0; };
  let best = 0, bestBpm = 120;
  for (let k = 0; k <= 1100; k++) {
    const bpm = 70 + k / 10, lag = fps * 60 / bpm;
    let score = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag);
    score *= Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2);   // zone 95-140 préférée
    if (score > best) { best = score; bestBpm = bpm; }
  }
  return Math.round(bestBpm * 10) / 10;
}

function energy(x) {
  const n = 1024, hop = 512, nf = frameCount(x.length, n, hop);
  let db = 0;
  for (let f = 0; f < nf; f++) {
    let s = 0; for (let i = 0; i < n; i++) s += x[f * hop + i] ** 2;
    db += 20 * Math.log10(Math.sqrt(s / n) + 1e-9);
  }
  const flux = spectralFlux(x, n, hop, true);
  return { loud: db / nf, punch: flux.reduce((s, v) => s + v, 0) / flux.length };
}

self.onmessage = e => {
  const { id, samples } = e.data;
  try {
    if (samples.length < SR * 10) throw new Error("extrait trop court");
    self.postMessage({ id, result: { ...estimateKey(samples), bpm: estimateBpm(samples), ...energy(samples) } });
  } catch (err) {
    self.postMessage({ id, error: String(err.message || err) });
  }
};
