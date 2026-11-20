const $ = id => document.getElementById(id);
const MODEL = "claude-sonnet-5-5";
const store = {
  get: keys => new Promise(res => chrome.storage.local.get(keys, res)),
  set: obj => new Promise(res => chrome.storage.local.set(obj, res)),
};
let data = null;      // {user, films:[{name,year,rating}], watchlist:[], recent:[{name,year,rating,date}]}
let apiKey = "";
let shown = [];
const stars = r => "★".repeat(Math.floor(r)) + (r % 1 ? "½" : "");
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- Letterboxd ---------- */
async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error("http " + r.status), { status: r.status });
  return r.text();
}

function parseFilms(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [], seen = new Set();
  doc.querySelectorAll("[data-film-slug],[data-item-slug]").forEach(el => {
    const slug = el.dataset.filmSlug || el.dataset.itemSlug;
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const li = el.closest("li") || el;
    const full = el.dataset.itemFullDisplayName || "";
    let name = el.dataset.filmName || el.dataset.itemName || full.replace(/\s*\(\d{4}\)\s*$/, "");
    if (!name) name = (el.querySelector("img")?.alt || "").replace(/^Poster for /, "");
    let year = +(el.dataset.filmReleaseYear || el.dataset.itemReleaseYear || (full.match(/\((\d{4})\)\s*$/) || [])[1]) || null;
    let rating = null;
    if (li.dataset.ownerRating) rating = +li.dataset.ownerRating / 2;
    else {
      const r = li.querySelector('[class*="rated-"]');
      const m = r && r.className.match(/rated-(\d+)/);
      if (m) rating = +m[1] / 2;
    }
    if (name) out.push({ name, year, rating: rating || null });
  });
  return out;
}

async function fetchAllPages(path, maxPages, onProgress) {
  const all = [];
  for (let start = 1; start <= maxPages; start += 3) {
    const pages = await Promise.all([0, 1, 2].map(i => {
      const n = start + i;
      if (n > maxPages) return [];
      return getText(`https://letterboxd.com/${path}/page/${n}/`).then(parseFilms)
        .catch(e => { if (e.status === 404 && n > 1) return []; throw e; });
    }));
    let done = false;
    for (const p of pages) { if (!p.length) { done = true; break; } all.push(...p); }
    onProgress(all.length);
    if (done) break;
  }
  return all;
}

function parseRSS(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const items = [...doc.querySelectorAll("item")].map(it => {
    const g = t => it.getElementsByTagName(t)[0]?.textContent || "";
    const name = g("letterboxd:filmTitle");
    if (!name) return null;
    return { name, year: +g("letterboxd:filmYear") || null, rating: +g("letterboxd:memberRating") || null, date: g("letterboxd:watchedDate") };
  }).filter(Boolean);
  const keys = new Set(), out = [];
  items.sort((a, b) => (b.date || "").localeCompare(a.date || "")).forEach(f => {
    const k = f.name + f.year;
    if (!keys.has(k) && out.length < 10) { keys.add(k); out.push(f); }
  });
  return out;
}

function cleanUser(v) {
  return v.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, "").split(/[\/?#]/)[0];
}

async function loadProfile() {
  const user = cleanUser($("user").value);
  if (!user) return setLoad("Type your Letterboxd username first.", true);
  $("load").disabled = true;
  setLoad("Reading your films…");
  try {
    const films = await fetchAllPages(`${user}/films`, 80, n => setLoad(`Reading your films… ${n} so far`));
    if (!films.length) throw Object.assign(new Error("empty"), { empty: true });
    let watchlist = [];
    setLoad("Reading your watchlist…");
    try { watchlist = await fetchAllPages(`${user}/watchlist`, 15, () => {}); } catch {}
    let recent = [];
    try { recent = parseRSS(await getText(`https://letterboxd.com/${user}/rss/`)); } catch {}
    if (!recent.length) recent = films.slice(0, 10).map(f => ({ ...f, date: "" }));
    data = { user, films, watchlist, recent };
    await store.set({ user, cache: data });
    setLoad("");
    showData();
  } catch (e) {
    setLoad(e.status === 404 ? `Couldn't find a Letterboxd profile called "${user}". Check the spelling.`
      : e.empty ? "No films found. Make sure your profile is public. If it is, Letterboxd may have changed its layout."
      : "Couldn't reach Letterboxd. Check your connection and try again.", true);
  } finally { $("load").disabled = false; }
}

function setLoad(t, err) { const s = $("loadStatus"); s.textContent = t; s.classList.toggle("err", !!err); }
function setStatus(t, err) { const s = $("status"); s.textContent = t; s.classList.toggle("err", !!err); }

function showData() {
  const rated = data.films.filter(f => f.rating);
  const avg = rated.length ? (rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(2) : "–";
  $("stats").innerHTML = `<span class="chip"><b>${data.films.length}</b> films logged</span><span class="chip"><b>${rated.length}</b> rated</span><span class="chip">average <b>${avg}★</b></span><span class="chip"><b>${data.watchlist.length}</b> on watchlist</span>`;
  $("favsBox").hidden = !rated.length;
  $("favs").innerHTML = "";
  [...rated].sort((a, b) => b.rating - a.rating).slice(0, 14).forEach(f => {
    const s = document.createElement("span"); s.className = "fav"; s.textContent = `${f.name} (${f.year}) `;
    const i = document.createElement("i"); i.textContent = stars(f.rating); s.append(i); $("favs").append(s);
  });
  $("recentPanel").hidden = false;
  $("recent").innerHTML = ""; $("simBox").hidden = true;
  data.recent.forEach(f => {
    const b = document.createElement("button"); b.type = "button"; b.className = "rfilm"; b.setAttribute("aria-pressed", "false");
    const t = document.createElement("b"); t.textContent = f.name;
    const s = document.createElement("span"); s.textContent = [f.year, f.date].filter(Boolean).join(" · ");
    b.append(t, s);
    if (f.rating) { const i = document.createElement("i"); i.textContent = stars(f.rating); b.append(i); }
    b.onclick = () => {
      document.querySelectorAll(".rfilm").forEach(x => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true"); similarTo(f);
    };
    $("recent").append(b);
  });
  updateGo();
}

/* ---------- Claude ---------- */
async function askClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || "http " + r.status), { status: r.status });
  const text = (j.content || []).map(c => c.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("bad reply");
  return JSON.parse(m[0]);
}

function claudeError(e) {
  if (e.status === 401) return "Your Claude API key was rejected. Open “Claude API key” above and check it.";
  if (e.status === 429) return "Too many requests. Wait a minute and try again.";
  if (/credit/i.test(e.message)) return "Your Claude API account has no credit left. Add some at console.anthropic.com → Billing.";
  return "Something went wrong getting recommendations. Try again.";
}

function seenFilter(list) {
  const years = new Map();
  data.films.forEach(f => { const k = norm(f.name); (years.get(k) || years.set(k, []).get(k)).push(f.year); });
  const wl = new Set(data.watchlist.map(f => norm(f.name)));
  return list.filter(r => {
    if (!r || !r.title) return false;
    const ys = years.get(norm(r.title));
    return !(ys && (!r.year || ys.some(y => !y || Math.abs(y - r.year) <= 1)));
  }).map(r => ({ ...r, onWatchlist: wl.has(norm(r.title)) }));
}

function seenList() {
  return [...new Set(data.films.map(f => `${f.name} (${f.year})`))].slice(0, 600).join("; ");
}

function buildPrompt(n) {
  const rated = data.films.filter(f => f.rating).sort((a, b) => b.rating - a.rating);
  const fmt = f => `${f.name} (${f.year}) ${f.rating}`;
  const loved = rated.filter(f => f.rating >= 4).slice(0, 100).map(fmt).join("; ");
  const disliked = rated.filter(f => f.rating <= 2.5).slice(-50).map(fmt).join("; ");
  const wl = data.watchlist.slice(0, 150).map(f => `${f.name} (${f.year})`).join("; ");
  const moods = [...document.querySelectorAll('.mood[aria-pressed="true"]')].map(b => b.dataset.p).join(" AND ");
  const sim = $("similar").value.trim();
  return `You are a film critic recommending movies to a Letterboxd user. Ratings are out of 5.
LOVED (4+): ${loved || "none"}
DISLIKED (2.5 or less): ${disliked || "none"}
SOME FILMS THEY HAVE SEEN, never recommend these: ${seenList()}
ALSO DON'T REPEAT: ${shown.join("; ") || "none"}
THEIR WATCHLIST (good candidates): ${wl || "none"}
Request: ${moods || "anything they'd love"}${sim ? `; similar in feel to "${sim}" (mention it in because)` : ""}; runtime ${$("len").value}. ${$("extra").value}
Recommend ${n} real feature films they have not seen. Mix well-known and lesser-known picks. Each "why" is 1-2 plain sentences about what they would like, specific to their taste. "because" lists 1-3 films from LOVED that it connects to.
Reply with ONLY a JSON array: [{"title":"","year":2000,"director":"","runtime":100,"why":"","because":[""]}]`;
}

async function similarTo(f) {
  $("simBox").hidden = false; $("simTitle").textContent = `Finding films like ${f.name}…`; $("simRecs").innerHTML = "";
  const loved = data.films.filter(x => x.rating >= 4).slice(0, 60).map(x => `${x.name} (${x.year}) ${x.rating}`).join("; ");
  const prompt = `A Letterboxd user just watched ${f.name} (${f.year})${f.rating ? `, rated ${f.rating}/5` : ""}. Their favourites: ${loved || "unknown"}.
NEVER recommend any of these films they have seen: ${seenList()}
Recommend 7 real films they haven't seen that are most similar to ${f.name}, ordered by similarity. "similarity" is an honest 0-100 score of how close it is in tone, style and themes. "why" is 1-2 plain sentences naming what it shares with ${f.name}.
Reply with ONLY a JSON array: [{"title":"","year":2000,"director":"","runtime":100,"similarity":85,"why":""}]`;
  try {
    const list = seenFilter(await askClaude(prompt)).slice(0, 5);
    $("simTitle").textContent = `Because you watched ${f.name}`;
    renderRecs(list, false, "simRecs");
  } catch (e) { $("simTitle").textContent = claudeError(e); }
}

async function recommend(append) {
  $("go").disabled = true; $("more").disabled = true;
  setStatus("Reading your log and picking films…");
  try {
    const fresh = seenFilter(await askClaude(buildPrompt(8))).slice(0, 6);
    shown.push(...fresh.map(r => `${r.title} (${r.year})`));
    $("out").hidden = false;
    renderRecs(fresh, append, "recs");
    setStatus("");
  } catch (e) { setStatus(claudeError(e), true); }
  finally { updateGo(); $("more").disabled = false; }
}

function renderRecs(list, append, target) {
  const ol = $(target);
  if (!append) ol.innerHTML = "";
  const start = ol.children.length;
  list.forEach((r, k) => {
    const li = document.createElement("li"); li.className = "rec";
    li.innerHTML = `<div class="rank"></div><div><h3></h3><div class="meta"></div><p class="why"></p><p class="because"></p><a target="_blank" rel="noopener">Open on Letterboxd ↗</a></div>`;
    li.querySelector(".rank").textContent = start + k + 1;
    const h = li.querySelector("h3"); h.textContent = r.title;
    const sm = document.createElement("small"); sm.textContent = r.year || ""; h.append(sm);
    if (r.similarity) { const m = document.createElement("span"); m.className = "match"; m.textContent = r.similarity + "% similar"; h.append(m); }
    if (r.onWatchlist) { const w = document.createElement("span"); w.className = "wl"; w.textContent = "On your watchlist"; h.append(w); }
    li.querySelector(".meta").textContent = [r.director, r.runtime && r.runtime + " min"].filter(Boolean).join(" · ");
    li.querySelector(".why").textContent = r.why || "";
    li.querySelector(".because").textContent = r.because?.length ? "Because you rated highly: " + r.because.join(", ") : "";
    li.querySelector("a").href = "https://letterboxd.com/search/films/" + encodeURIComponent(r.title + " " + (r.year || "")) + "/";
    ol.append(li);
  });
}

/* ---------- Wiring ---------- */
function updateGo() {
  $("go").disabled = !(data && apiKey);
  $("keyState").textContent = apiKey ? "· saved" : "· needed for recommendations";
  if (!apiKey) $("keyBox").open = true;
}

document.querySelectorAll(".mood").forEach(b => {
  b.setAttribute("aria-pressed", "false");
  b.onclick = () => b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
});
$("load").onclick = loadProfile;
$("user").addEventListener("keydown", e => { if (e.key === "Enter") loadProfile(); });
$("go").onclick = () => { shown = []; recommend(false); };
$("more").onclick = () => recommend(true);
$("saveKey").onclick = async () => {
  apiKey = $("key").value.trim();
  await store.set({ apiKey });
  $("key").value = apiKey ? "•".repeat(12) : "";
  updateGo();
};

(async () => {
  const s = await store.get(["apiKey", "user", "cache"]);
  apiKey = s.apiKey || "";
  if (apiKey) $("key").value = "•".repeat(12);
  if (s.user) $("user").value = s.user;
  if (s.cache) { data = s.cache; showData(); }
  updateGo();
})();
