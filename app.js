// Stream Suggest — version téléphone / tablette (appli web installable).
// Suggestions : API publique Deezer (JSONP) + analyse des extraits 30 s dans le téléphone.
// Spotify : morceau en cours et file d'attente via l'API officielle (connexion PKCE, sans serveur).
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("ss:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ss:" + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("ss:" + k); } catch {} },
};

/* ---------------- Deezer (JSONP : l'API n'autorise pas les appels directs depuis une page) ---------------- */
const dz = (() => {
  let n = 0, last = 0;
  const cache = new Map();
  async function get(path, params = {}) {
    const qs = new URLSearchParams({ ...params, output: "jsonp" });
    const key = path + "?" + qs;
    if (cache.has(key)) return cache.get(key);
    const wait = 120 - (Date.now() - last);      // Deezer : 50 requêtes / 5 s
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const p = new Promise((resolve) => {
      const cb = "__dz" + (++n), s = document.createElement("script");
      const done = d => { delete window[cb]; s.remove(); clearTimeout(t); resolve(d || {}); };
      const t = setTimeout(() => done({}), 12000);
      window[cb] = done;
      qs.set("callback", cb);
      s.src = `https://api.deezer.com${path}?${qs}`;
      s.onerror = () => done({});
      document.head.appendChild(s);
    });
    cache.set(key, p);
    const d = await p;
    if (!d || d.error) cache.delete(key);
    return d;
  }
  return { get };
})();

function slim(t, from) {
  return {
    id: t.id, title: t.title_short || t.title, full_title: t.title, artist: t.artist.name, artist_id: t.artist.id,
    album: t.album?.title || "", cover: t.album?.cover_medium || "", rank: t.rank || 0, preview: t.preview || "",
    isrc: t.isrc || null, from,
  };
}

function norm(s) {
  s = (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  s = s.replace(/\(.*?\)|\[.*?\]| - .*$|feat\..*$|ft\..*$/g, " ");
  return s.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).join(" ");
}
const same = (a, b) => { a = norm(a); b = norm(b); return !!a && (a === b || a.includes(b) || b.includes(a)); };

async function dzSearch(q, limit = 15) {
  const d = await dz.get("/search", { q, limit });
  return (d.data || []).filter(t => t.preview).map(t => slim(t));
}

async function dzMatch(artist, title, isrc) {
  if (isrc) {
    const d = await dz.get(`/track/isrc:${isrc}`);
    if (d.id && d.preview) return slim(d);
  }
  const main = (artist || "").split(/,| & | feat| x /i)[0];
  const res = (await dzSearch(`${main} ${norm(title)}`, 10));
  const score = t => (norm(t.title) === norm(title) ? 3 : same(t.full_title, title) ? 1.5 : 0) +
                     (norm(t.artist) === norm(main) ? 2 : same(t.artist, main) ? 1 : 0) + t.rank / 1e7;
  const best = res.sort((a, b) => score(b) - score(a))[0];
  return best && score(best) >= 2.5 ? best : null;
}

async function candidates(seed) {
  const out = [], seen = new Set([seed.id]);
  const add = (items, from) => { for (const t of items || []) if (t.preview && !seen.has(t.id)) { seen.add(t.id); out.push(slim(t, from)); } };
  add((await dz.get(`/artist/${seed.artist_id}/radio`, { limit: 40 })).data, "radio");
  const rel = (await dz.get(`/artist/${seed.artist_id}/related`, { limit: 10 })).data || [];
  const tops = await Promise.all(rel.map(a => dz.get(`/artist/${a.id}/top`, { limit: 4 })));
  tops.forEach(d => add(d.data, "proche"));
  add((await dz.get(`/artist/${seed.artist_id}/top`, { limit: 6 })).data, "artiste");
  return out;
}

/* ---------------- Analyse (dans le téléphone) ---------------- */
const analysis = (() => {
  const results = store.get("analyses", {});      // id Deezer -> {bpm, camelot, key, loud, punch}
  const failed = new Set(), queued = new Map();
  let worker = null, jobs = 0, saveTimer = null, energyCache = null;
  const waiting = [], workerJobs = new Map();
  let running = 0;
  function getWorker() {
    if (!worker) {
      worker = new Worker("analysis-worker.js");
      worker.onmessage = e => { const j = workerJobs.get(e.data.id); workerJobs.delete(e.data.id); j && j(e.data); };
    }
    return worker;
  }
  async function decode(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 11025 * 32, 11025);        // décode ET ramène à 11025 Hz
    const audio = await new Promise((ok, ko) => { const p = ctx.decodeAudioData(buf, ok, ko); if (p && p.catch) p.catch(ko); });
    if (audio.sampleRate !== 11025) throw new Error("rééchantillonnage impossible");
    const n = audio.length, out = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / audio.numberOfChannels; }
    return out;
  }
  async function work(t) {
    const samples = await decode(t.preview);
    const id = ++jobs;
    const r = await new Promise(res => { workerJobs.set(id, res); getWorker().postMessage({ id, samples }, [samples.buffer]); });
    if (r.error) throw new Error(r.error);
    return r.result;
  }
  function pump() {
    while (running < 3 && waiting.length) {
      const t = waiting.shift();
      running++;
      work(t).then(r => {
        results[t.id] = { bpm: r.bpm, camelot: r.camelot, key: r.key, loud: r.loud, punch: r.punch };
        energyCache = null;
        clearTimeout(saveTimer); saveTimer = setTimeout(save, 1500);
      }).catch(() => failed.add(t.id)).finally(() => {
        running--; queued.get(t.id)?.forEach(f => f()); queued.delete(t.id); pump(); onProgress();
      });
    }
  }
  function save() {
    const ids = Object.keys(results);
    if (ids.length > 4000) ids.slice(0, ids.length - 4000).forEach(k => delete results[k]);
    store.set("analyses", results);
  }
  function queue(t, first = false) {
    if (results[t.id] || failed.has(t.id)) return Promise.resolve();
    return new Promise(res => {
      if (queued.has(t.id)) { queued.get(t.id).push(res); return; }
      queued.set(t.id, [res]);
      first ? waiting.unshift(t) : waiting.push(t);
      pump();
    });
  }
  function energies() {
    if (energyCache) return energyCache;
    const ids = Object.keys(results);
    if (ids.length < 5) return {};
    const L = ids.map(i => results[i].loud), P = ids.map(i => results[i].punch);
    const z = a => { const m = a.reduce((s, v) => s + v, 0) / a.length, sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); return a.map(v => (v - m) / (sd + 1e-9)); };
    const zl = z(L), zp = z(P), s = ids.map((_, i) => zl[i] + zp[i]);
    const order = s.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    energyCache = {};
    order.forEach(([, i], r) => { energyCache[ids[i]] = Math.round(1 + 9 * r / Math.max(1, ids.length - 1)); });
    return energyCache;
  }
  let onProgress = () => {};
  return { results, failed, queue, energies, set onProgress(f) { onProgress = f; } };
})();

function info(t) {
  const a = analysis.results[t.id] || {};
  return { ...t, bpm: a.bpm, camelot: a.camelot, key: a.key, energy: analysis.energies()[t.id], analysed: !!a.bpm };
}

/* ---------------- Notation (mêmes règles que DJ Suggest) ---------------- */
function keyMatch(a, b) {
  if (!a || !b) return [0.3, "tonalité inconnue"];
  const na = parseInt(a), la = a.slice(-1), nb = parseInt(b), lb = b.slice(-1), step = ((nb - na) % 12 + 12) % 12;
  if (la === lb) {
    if (step === 0) return [1, "même tonalité"];
    if (step === 1 || step === 11) return [0.9, "tonalité voisine"];
    if (step === 2) return [0.6, "boost d'énergie (+2)"];
    if (step === 7) return [0.5, "+1 demi-ton"];
  } else {
    if (step === 0) return [0.85, "relative majeur/mineur"];
    if ((la === "A" && step === 1) || (la === "B" && step === 11)) return [0.5, "diagonale"];
  }
  return [0, "tonalité éloignée"];
}
function bpmMatch(a, b, tol) {
  if (!a || !b) return [0, null, false];
  const diff = Math.min(...[1, 2, 0.5].map(f => Math.abs(b * f - a) / a));
  return [Math.max(0, 1 - diff / tol), diff * 100, Math.abs(b - a) / a > diff + 1e-9];
}

function suggest(cur, cands, { mode, tol, exclude }) {
  let target = cur.energy;
  if (target != null) target = Math.min(10, Math.max(1, target + ({ monter: 1, descendre: -1 }[mode] || 0)));
  const out = []; let waiting = 0;
  for (const c of cands) {
    const t = info(c);
    if (!t.analysed) { if (!analysis.failed.has(c.id)) waiting++; continue; }
    if (exclude.has(String(t.id)) || exclude.has(norm(t.artist + " " + t.title))) continue;
    if (norm(t.title) === norm(cur.title)) continue;
    const [bs, bd, hd] = bpmMatch(cur.bpm, t.bpm, tol / 100);
    if (bs <= 0) continue;
    const [ks, why] = keyMatch(cur.camelot, t.camelot);
    const es = target == null || t.energy == null ? 0.5 : Math.max(0, 1 - Math.abs(t.energy - target) / 3);
    const total = 0.4 * ks + 0.35 * bs + 0.25 * es + 0.04 * Math.min(1, (t.rank || 0) / 900000);
    out.push({ ...t, score: Math.min(100, Math.round(total * 100)), _r: total, why, bpm_diff: Math.round(bd * 10) / 10, half_double: hd });
  }
  out.sort((a, b) => b._r - a._r);
  const per = {}, seen = new Set(), list = [];
  for (const t of out) {
    const sig = norm(t.artist + " " + t.title);
    if (seen.has(sig) || (per[t.artist_id] || 0) >= 2) continue;
    seen.add(sig); per[t.artist_id] = (per[t.artist_id] || 0) + 1; list.push(t);
  }
  return { list: list.slice(0, 30), waiting, total: cands.length };
}

/* ---------------- Spotify (API officielle, connexion PKCE) ---------------- */
const spotify = (() => {
  const SCOPES = "user-read-currently-playing user-read-playback-state user-modify-playback-state";
  const clientId = () => (window.SS_CONFIG?.spotifyClientId || store.get("clientId", "")).trim();
  const redirect = () => location.origin + location.pathname;
  let tok = store.get("spotify", null);
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  async function login() {
    const verifier = b64(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    store.set("verifier", verifier);
    location.href = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: clientId(), response_type: "code", redirect_uri: redirect(), scope: SCOPES,
      code_challenge_method: "S256", code_challenge: challenge,
    });
  }
  async function tokenRequest(body) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId(), ...body }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || "connexion refusée");
    tok = { access: d.access_token, refresh: d.refresh_token || tok?.refresh, exp: Date.now() + (d.expires_in - 60) * 1000 };
    store.set("spotify", tok);
  }
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has("code") && !p.has("error")) return null;
    history.replaceState(null, "", redirect());
    if (p.get("error")) return "Connexion Spotify annulée.";
    try { await tokenRequest({ grant_type: "authorization_code", code: p.get("code"), redirect_uri: redirect(), code_verifier: store.get("verifier", "") }); }
    catch (e) { return "Connexion Spotify impossible : " + e.message; }
    return "Spotify connecté.";
  }
  async function api(path, opts = {}) {
    if (!tok) throw new Error("non connecté");
    if (Date.now() > tok.exp) {
      try { await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh }); }
      catch (e) { logout(); throw new Error("Reconnecte Spotify."); }
    }
    const r = await fetch("https://api.spotify.com/v1" + path, { ...opts, headers: { Authorization: "Bearer " + tok.access } });
    if (r.status === 401) { tok.exp = 0; return api(path, opts); }
    if (r.status === 204) return null;
    const d = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(d?.error?.message || "erreur Spotify " + r.status); e.status = r.status; e.reason = d?.error?.reason; throw e; }
    return d;
  }
  function logout() { tok = null; store.del("spotify"); }
  async function nowPlaying() {
    const d = await api("/me/player/currently-playing?additional_types=track");
    if (!d || !d.item || d.item.type !== "track") return null;
    const it = d.item;
    return { title: it.name, artist: it.artists.map(a => a.name).join(", "), isrc: it.external_ids?.isrc, spotify_id: it.id,
             cover: it.album?.images?.[1]?.url || it.album?.images?.[0]?.url, position: d.progress_ms / 1000,
             duration: it.duration_ms / 1000, playing: d.is_playing };
  }
  async function findTrack(t) {
    let isrc = t.isrc;
    if (!isrc) { const d = await dz.get(`/track/${t.id}`); isrc = d.isrc; t.isrc = isrc; }
    if (isrc) {
      const r = await api("/search?" + new URLSearchParams({ q: "isrc:" + isrc, type: "track", limit: 1 }));
      if (r?.tracks?.items?.[0]) return r.tracks.items[0];
    }
    const r = await api("/search?" + new URLSearchParams({ q: `track:${norm(t.title)} artist:${t.artist}`, type: "track", limit: 5 }));
    return (r?.tracks?.items || []).find(x => same(x.name, t.title)) || r?.tracks?.items?.[0] || null;
  }
  async function addToQueue(t) {
    const st = await findTrack(t);
    if (!st) return [false, "Morceau introuvable sur Spotify."];
    try { await api("/me/player/queue?" + new URLSearchParams({ uri: st.uri }), { method: "POST" }); }
    catch (e) {
      if (e.reason === "NO_ACTIVE_DEVICE" || e.status === 404) return [false, "Lance d'abord la lecture dans Spotify (aucun appareil actif)."];
      if (e.reason === "PREMIUM_REQUIRED" || e.status === 403) return [false, "Spotify Premium est nécessaire pour la file d'attente."];
      return [false, e.message];
    }
    return [true, "Ajouté à la file d'attente Spotify."];
  }
  return { login, logout, handleRedirect, nowPlaying, addToQueue, findTrack, clientId, get connected() { return !!tok; } };
})();

/* ---------------- Interface ---------------- */
let current = null, cands = [], live = null, manual = false, mode = store.get("mode", "garder"), playingId = null, suggestTimer = null;
const queued = new Set(), adding = new Set(), played = [];

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 3000); }
function fmt(s) { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
const camClass = why => /même|voisine|relative/.test(why) ? "k1" : /boost|demi|diagonale/.test(why) ? "k2" : "";
function bars(e) { let h = '<span class="en">'; for (let i = 1; i <= 10; i++) h += `<i class="${e && i <= e ? "on" : ""}" style="height:${3 + i}px"></i>`; return h + "</span>"; }

function renderNow() {
  if (!current) return;
  const t = info(current);
  const src = live && !manual ? `<span class="badge live">● Spotify</span>` : `<span class="badge">choisi à la main</span>`;
  const prog = live && !manual && live.duration ? `<div class="bar"><b style="width:${Math.min(100, 100 * live.position / live.duration)}%"></b></div>
      <div class="left">reste ${fmt(live.duration - live.position)}${live.playing ? "" : " · en pause"}</div>` : "";
  $("#now").innerHTML = `
    <img src="${esc(t.cover)}" alt="">
    <div class="nt">
      <div class="label">En cours ${src}</div>
      <div class="title">${esc(t.title)}</div>
      <div class="artist">${esc(t.artist)}</div>
      ${prog}
    </div>
    <div class="stats">
      <div class="stat"><b>${t.bpm ? "≈" + Math.round(t.bpm) : "…"}</b><small>BPM</small></div>
      <div class="stat"><b>${esc(t.camelot || "…")}</b><small>${esc(t.key || "Clé")}</small></div>
      <div class="stat"><b>${t.energy ?? "…"}</b><small>Énergie</small></div>
    </div>`;
}

async function select(t, isManual) {
  current = t; manual = isManual; cands = [];
  if (isManual) $("#follow").checked = false;
  renderNow();
  $("#list").innerHTML = '<div class="empty">Écoute des morceaux proches…</div>';
  await analysis.queue(t, true);
  if (current !== t) return;
  renderNow();
  cands = await candidates(t);
  if (current !== t) return;
  cands.forEach(c => analysis.queue(c));
  refresh();
}

function refresh() {
  if (!current) return;
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => {
    renderNow();
    if (!cands.length) return;
    const exclude = new Set([...queued, ...played.map(h => norm(h))]);
    const r = suggest(info(current), cands, { mode, tol: +$("#tol").value, exclude });
    const done = r.total - r.waiting;
    $("#prog").style.width = r.total ? `${100 * done / r.total}%` : "0";
    $("#info").textContent = r.waiting ? `Analyse ${done}/${r.total}…` : `${r.list.length} suggestions sur ${r.total} morceaux`;
    renderList(r.list, r.waiting);
  }, 150);
}
analysis.onProgress = refresh;

// lecteur choisi sur cet appareil : change le bouton principal de chaque suggestion
let player = store.get("player", null) || (spotify.connected ? "spotify" : "deezer");
function primaryButton(t, i) {
  if (player === "spotify" && spotify.connected)
    return `<button class="q" data-q="${i}" ${adding.has(t.id) ? "disabled" : ""}>${adding.has(t.id) ? "Ajout…" : "+ À la suite"}</button>`;
  if (player === "deezer") return `<button class="q dzq" data-open="deezer" data-i="${i}">Ouvrir dans Deezer ›</button>`;
  if (player === "music") return `<button class="q amq" data-open="music" data-i="${i}">Ouvrir dans Apple Music ›</button>`;
  return `<button class="q" data-connect="1">Connecter Spotify pour « À la suite »</button>`;
}
function renderPlayer() {
  document.querySelectorAll("#players button").forEach(b => b.classList.toggle("on", b.dataset.p === player));
  $("#spBtn").hidden = player !== "spotify";
  $("#dzHelp").hidden = player !== "deezer";
  $("#follow").closest("label").hidden = !(player === "spotify" && spotify.connected);
  const e = $("#nowEmpty");
  if (e) e.textContent = player === "spotify" && !spotify.connected ? "Connecte Spotify pour suivre le morceau en cours, ou cherche un morceau."
                                                                   : "Cherche le morceau qui passe pour voir quoi enchaîner.";
}
document.querySelectorAll("#players button").forEach(b => b.onclick = () => {
  player = b.dataset.p; store.set("player", player); renderPlayer(); refresh();
});

function renderList(list, waiting) {
  if (!list.length) {
    $("#list").innerHTML = `<div class="empty">${waiting ? "Écoute des morceaux proches…" : "Aucun enchaînement dans cette tolérance de BPM. Essaie ±10 %."}</div>`;
    return;
  }
  $("#list").innerHTML = list.map((t, i) => `
    <div class="row">
      <img src="${esc(t.cover)}" alt="" loading="lazy">
      <div class="main">
        <div class="t">${esc(t.title)}</div>
        <div class="a">${esc(t.artist)}</div>
        <div class="why">${esc(t.why)}${t.half_double ? " · double/moitié tempo" : ""} <em>· ${t.from === "radio" ? "radio" : t.from === "proche" ? "artiste proche" : "même artiste"}</em></div>
      </div>
      <div class="score">${t.score}</div>
      <div class="meta">
        <span class="num">≈${Math.round(t.bpm)} <small>${t.bpm_diff < 0.5 ? "pile" : "±" + t.bpm_diff + " %"}</small></span>
        <span class="cam ${camClass(t.why)}">${esc(t.camelot)}</span>
        ${bars(t.energy)}
      </div>
      <div class="acts">
        ${primaryButton(t, i)}
        <button class="pl ${playingId === t.id ? "on" : ""}" data-pl="${i}" aria-label="Écouter l'extrait">${playingId === t.id ? "■" : "▶"}</button>
        <button class="sp" data-open="spotify" data-i="${i}" aria-label="Ouvrir dans Spotify">S</button>
        <button class="dz" data-open="deezer" data-i="${i}" aria-label="Ouvrir dans Deezer">D</button>
        <button class="am" data-open="music" data-i="${i}" aria-label="Ouvrir dans Apple Music">♫</button>
        <button data-pick="${i}" aria-label="Partir de ce morceau">⤵</button>
      </div>
    </div>`).join("");
  $("#list")._data = list;
}

async function appleUrl(t) {
  try {
    const r = await (await fetch("https://itunes.apple.com/search?" + new URLSearchParams({ term: `${t.artist} ${norm(t.title)}`, entity: "song", country: "fr", limit: 10 }))).json();
    const hit = r.results.find(x => same(x.trackName, t.title) && same(x.artistName, t.artist)) || r.results[0];
    return hit?.trackViewUrl?.split("&uo=")[0] || null;
  } catch { return null; }
}

async function openIn(app, t) {
  // fenêtre ouverte tout de suite (sinon Safari bloque l'ouverture après une attente)
  const w = window.open("about:blank", "_blank");
  let url;
  if (app === "deezer") url = `https://www.deezer.com/track/${t.id}`;
  else if (app === "music") url = (await appleUrl(t)) || `https://music.apple.com/fr/search?term=${encodeURIComponent(t.artist + " " + t.title)}`;
  else {
    let st = null;
    if (spotify.connected) { try { st = await spotify.findTrack(t); } catch {} }
    url = st ? `https://open.spotify.com/track/${st.id}` : `https://open.spotify.com/search/${encodeURIComponent(t.artist + " " + norm(t.title))}`;
  }
  if (w) w.location = url; else location.href = url;
}

$("#list").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.connect) { $("#spBtn").click(); return; }
  const list = $("#list")._data, t = list[b.dataset.q ?? b.dataset.pl ?? b.dataset.i ?? b.dataset.pick];
  if (!t) return;
  if (b.dataset.q !== undefined) {
    adding.add(t.id); b.disabled = true; b.textContent = "Ajout…";
    let ok, msg;
    try { [ok, msg] = await spotify.addToQueue(t); } catch (err) { ok = false; msg = err.message; }
    adding.delete(t.id); toast(msg);
    if (ok) { queued.add(String(t.id)); refresh(); } else { b.disabled = false; b.textContent = "+ À la suite"; }
  } else if (b.dataset.pl !== undefined) {
    const a = $("#audio");
    if (playingId === t.id) { a.pause(); playingId = null; }
    else { a.src = t.preview; a.play().catch(() => {}); playingId = t.id; }
    refresh();
  } else if (b.dataset.open) {
    openIn(b.dataset.open, t);
  } else if (b.dataset.pick !== undefined) {
    $("#audio").pause(); playingId = null;
    select(t, true); window.scrollTo({ top: 0, behavior: "smooth" });
  }
});
$("#audio").addEventListener("ended", () => { playingId = null; refresh(); });

document.querySelectorAll("#mode button").forEach(b => {
  b.classList.toggle("on", b.dataset.v === mode);
  b.onclick = () => { mode = b.dataset.v; store.set("mode", mode); document.querySelectorAll("#mode button").forEach(x => x.classList.toggle("on", x === b)); refresh(); };
});
$("#tol").value = store.get("tol", "6");
$("#tol").onchange = () => { store.set("tol", $("#tol").value); refresh(); };
$("#follow").onchange = () => { if ($("#follow").checked) { manual = false; lastLive = null; pollSpotify(); } };

let sTimer;
$("#q").addEventListener("input", () => {
  clearTimeout(sTimer);
  const q = $("#q").value.trim();
  if (!q) { $("#results").hidden = true; return; }
  sTimer = setTimeout(async () => {
    const link = q.match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i);
    let res;
    if (link) {
      const d = await dz.get(`/track/${link[1]}`);
      res = d.id ? [slim(d)] : [];
    } else if (/link\.deezer\.com|deezer\.page\.link/i.test(q)) {
      $("#results").innerHTML = `<div class="empty">Lien court Deezer : ouvre-le une fois dans Safari puis copie l'adresse deezer.com/track/…, ou tape simplement le titre.</div>`;
      $("#results")._data = []; $("#results").hidden = false; return;
    } else res = await dzSearch(q, 15);
    $("#results").innerHTML = res.map((t, i) => `<button data-i="${i}"><img src="${esc(t.cover)}" alt=""><span>${esc(t.title)}<small>${esc(t.artist)} · ${esc(t.album)}</small></span></button>`).join("") || '<div class="empty">Aucun résultat</div>';
    $("#results")._data = res; $("#results").hidden = false;
  }, 300);
});
$("#results").addEventListener("click", e => {
  const b = e.target.closest("button[data-i]"); if (!b) return;
  const t = $("#results")._data[b.dataset.i];
  $("#results").hidden = true; $("#q").value = ""; $("#q").blur();
  select(t, true);
});
document.addEventListener("click", e => { if (!e.target.closest(".search")) $("#results").hidden = true; });

/* ---- Spotify : connexion et suivi en direct ---- */
function renderSpotify() {
  const c = spotify.connected;
  renderPlayer();
  $("#spBtn").textContent = c ? "Spotify connecté" : "Connecter Spotify";
  $("#spBtn").classList.toggle("on", c);
}
$("#spBtn").onclick = () => {
  if (spotify.connected) { if (confirm("Déconnecter Spotify sur cet appareil ?")) { spotify.logout(); live = null; renderSpotify(); refresh(); } return; }
  if (!spotify.clientId()) { $("#setup").hidden = false; return; }
  spotify.login();
};
$("#saveClient").onclick = () => {
  const v = $("#clientId").value.trim();
  if (!/^[0-9a-f]{32}$/i.test(v)) { toast("L'identifiant Spotify fait 32 caractères (chiffres et lettres a-f)."); return; }
  store.set("clientId", v); $("#setup").hidden = true; spotify.login();
};
$("#closeSetup").onclick = () => { $("#setup").hidden = true; };
$("#redirectUri").textContent = location.origin + location.pathname;

let lastLive = null, polling = false;
async function pollSpotify() {
  if (!spotify.connected || player !== "spotify" || polling || document.hidden) return;
  polling = true;
  try {
    live = await spotify.nowPlaying();
    if (live && $("#follow").checked) {
      const sig = live.artist + "|" + live.title;
      if (sig !== lastLive) {
        lastLive = sig;
        played.push(live.artist + " " + live.title);
        const t = await dzMatch(live.artist, live.title, live.isrc);
        if (t) { if (!t.cover) t.cover = live.cover; select(t, false); }
        else toast(`« ${live.title} » introuvable sur Deezer : cherche-le à la main.`);
      } else renderNow();
    }
  } catch (e) { if (!spotify.connected) renderSpotify(); }
  polling = false;
}
setInterval(pollSpotify, 4000);
document.addEventListener("visibilitychange", pollSpotify);

/* ---- installation ---- */
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
if (!standalone && !store.get("hideInstall", false)) {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  $("#install").hidden = false;
  $("#installText").textContent = ios ? "Pour l'avoir comme une appli : bouton Partager ⬆︎ puis « Sur l'écran d'accueil »."
                                      : "Pour l'avoir comme une appli : menu ⋮ du navigateur puis « Installer l'appli » / « Ajouter à l'écran d'accueil ».";
}
$("#hideInstall").onclick = () => { $("#install").hidden = true; store.set("hideInstall", true); };
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  const msg = await spotify.handleRedirect();
  if (msg) toast(msg);
  renderSpotify();
  pollSpotify();
})();
