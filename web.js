const $ = id => document.getElementById(id);
const MODEL = "claude-sonnet-5-5";
const PROXY = "https://morning-heart-3d02.michalinabukowiecka.workers.dev";
const store = {
  get: async keys => { const o = {}; for (const k of keys) { try { const v = localStorage.getItem("nftw_" + k); if (v !== null) o[k] = JSON.parse(v); } catch {} } return o; },
  set: async obj => { for (const k in obj) { try { localStorage.setItem("nftw_" + k, JSON.stringify(obj[k])); } catch {} } },
};
let data = null;      // {user, films:[{name,year,rating}], watchlist:[], recent:[{name,year,rating,date}]}
let apiKey = "";
let shown = [];
const stars = r => "★".repeat(Math.floor(r)) + (r % 1 ? "½" : "");
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- Letterboxd ---------- */
async function getText(url) {
  const r = await fetch(PROXY + "/?url=" + encodeURIComponent(url));
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
    if (name) out.push({ name, year, rating: rating || null, slug });
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
    return { name, year: +g("letterboxd:filmYear") || null, rating: +g("letterboxd:memberRating") || null, date: g("letterboxd:watchedDate"), liked: g("letterboxd:memberLike") === "Yes", slug: ((g("link").match(/\/film\/([^/]+)\//) || [])[1] || ""), poster: ((g("description").match(/<img[^>]+src="([^"]+)"/) || [])[1] || "") };
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
    setLoad("Reading your favourites and this year…");
    let favs = [], year = null;
    try { favs = await fetchFavs(user); } catch {}
    try { year = await fetchYear(user); } catch {}
    data = { user, films, watchlist, recent, favs, year };
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

const parseDoc = h => new DOMParser().parseFromString(h, "text/html");

async function fetchFavs(user) {
  const doc = parseDoc(await getText("https://letterboxd.com/" + user + "/"));
  const list = [...doc.querySelectorAll("#favourites li.griditem")].slice(0, 4).map(li => {
    const d = li.querySelector("[data-item-name],[data-film-name]") || li;
    const img = li.querySelector("img");
    const full = d.dataset.itemName || d.dataset.filmName || (img && img.alt) || "";
    const m = full.match(/^(.*?)\s*\((\d{4})\)\s*$/);
    return { name: m ? m[1] : full, year: m ? +m[2] : null, slug: d.dataset.itemSlug || d.dataset.filmSlug || "", poster: "" };
  }).filter(f => f.name);
  await Promise.all(list.map(async f => { f.poster = await filmPoster(f.slug); }));
  return list;
}

async function filmPoster(slug) {
  if (!slug) return "";
  try {
    const doc = parseDoc(await getText("https://letterboxd.com/film/" + slug + "/"));
    const ld = doc.querySelector('script[type="application/ld+json"]');
    const j = JSON.parse(ld.textContent.replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\/\s*$/g, ""));
    return typeof j.image === "string" ? j.image : "";
  } catch { return ""; }
}

async function fetchYear(user) {
  const year = new Date().getFullYear(), byId = new Map();
  for (let n = 1; n <= 25; n++) {
    let rows;
    try { rows = [...parseDoc(await getText("https://letterboxd.com/" + user + "/diary/for/" + year + "/page/" + n + "/")).querySelectorAll("tr.diary-entry-row")]; }
    catch (e) { if (e.status === 404) break; throw e; }
    if (!rows.length) break;
    rows.forEach(tr => {
      const id = tr.dataset.productionUid || tr.dataset.objectId;
      const r = tr.querySelector(".col-rating [class*='rated-']");
      const m = r && r.className.match(/rated-(\d+)/);
      const rating = m ? +m[1] / 2 : null;
      const cur = byId.get(id);
      if (!cur) byId.set(id, { rating }); else if (cur.rating == null && rating != null) cur.rating = rating;
    });
    if (rows.length < 50) break;
  }
  const rs = [...byId.values()].map(x => x.rating).filter(Boolean);
  return { year, count: byId.size, rated: rs.length, avg: rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : null };
}

function fmtDate(d) {
  if (!d) return "";
  const t = new Date(d + "T12:00:00");
  if (isNaN(t)) return d;
  const sameYear = t.getFullYear() === new Date().getFullYear();
  return t.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

function filmCard(f, cls, pick) {
  const b = document.createElement("button"); b.type = "button"; b.className = cls; b.setAttribute("aria-pressed", "false");
  b.title = f.name + (f.year ? " (" + f.year + ")" : ""); b.setAttribute("aria-label", b.title);
  if (f.poster) { const im = document.createElement("img"); im.src = f.poster; im.alt = ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer"; b.append(im); }
  else { const t = document.createElement("b"); t.textContent = f.name; b.append(t); }
  if (cls === "rfilm") {
    const m = document.createElement("div"); m.className = "meta2";
    if (f.rating) { const i = document.createElement("i"); i.textContent = stars(f.rating); m.append(i); }
    if (f.liked) { const h = document.createElement("em"); h.textContent = "♥"; h.title = "Liked"; m.append(h); }
    if (f.date) { const d = document.createElement("span"); d.textContent = fmtDate(f.date); m.append(d); }
    b.append(m);
  }
  b.onclick = () => {
    document.querySelectorAll("." + cls).forEach(x => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true"); pick(f);
  };
  return b;
}

function showData() {
  const rated = data.films.filter(f => f.rating);
  const avg = rated.length ? (rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(2) : "–";
  const y = data.year;
  const tile = (big, small) => '<div class="stat"><b>' + big + '</b><span>' + small + '</span></div>';
  $("stats").innerHTML = tile(data.films.length.toLocaleString("en"), "films logged") + tile(avg + "★", "average rating, all logged films")
    + (y ? tile(y.count, "watched in " + y.year) + tile((y.avg ? y.avg.toFixed(2) : "–") + "★", "average rating in " + y.year) : "");

  const favs = (data.favs && data.favs.length) ? data.favs
    : [...rated].sort((a, b) => b.rating - a.rating).slice(0, 4).map(f => ({ name: f.name, year: f.year, poster: "" }));
  $("favPanel").hidden = !favs.length;
  $("favs").innerHTML = ""; $("fsBox").hidden = true;
  favs.forEach(f => {
    const mine = data.films.find(x => norm(x.name) === norm(f.name) && (!x.year || !f.year || x.year === f.year));
    $("favs").append(filmCard({ ...f, rating: mine && mine.rating }, "favcard", x => similarTo(x, ["fsBox", "fsTitle", "fsRecs"], "love")));
  });

  $("recentPanel").hidden = false;
  $("recent").innerHTML = ""; $("simBox").hidden = true;
  data.recent.forEach(f => $("recent").append(filmCard(f, "rfilm", x => similarTo(x))));
  updateGo();
}

/* ---------- Recommendations from Letterboxd only (no AI, no API key) ---------- */
const detailCache = new Map();

async function pmap(items, fn, limit = 6) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}

function getDetails(slug) {
  if (detailCache.has(slug)) return detailCache.get(slug);
  const p = (async () => {
    const doc = parseDoc(await getText("https://letterboxd.com/film/" + slug + "/"));
    const ld = JSON.parse(doc.querySelector('script[type="application/ld+json"]').textContent.replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\/\s*$/g, ""));
    const foot = (doc.querySelector(".text-footer") || {}).textContent || "";
    const rm = foot.match(/(\d+)\s*mins?/);
    const agg = ld.aggregateRating || {};
    return {
      slug, title: ld.name, year: parseInt(String(ld.dateCreated || "").slice(0, 4)) || null,
      director: (ld.director || []).map(x => x.name).slice(0, 2).join(", "), runtime: rm ? +rm[1] : null,
      rating: agg.ratingValue || null, count: agg.ratingCount || 0, genres: ld.genre || [],
      poster: typeof ld.image === "string" ? ld.image : "",
    };
  })();
  detailCache.set(slug, p);
  p.catch(() => detailCache.delete(slug));
  return p;
}

async function similarList(slug) {
  const doc = parseDoc(await getText("https://letterboxd.com/film/" + slug + "/similar/"));
  const out = [], seen = new Set();
  doc.querySelectorAll("[data-item-slug],[data-film-slug]").forEach(el => {
    const s = el.dataset.itemSlug || el.dataset.filmSlug;
    if (s && s !== slug && !seen.has(s)) { seen.add(s); out.push(s); }
  });
  return out;
}

async function findSlug(name, year) {
  const doc = parseDoc(await getText("https://letterboxd.com/s/search/films/" + encodeURIComponent(name) + "/"));
  const els = [...doc.querySelectorAll("[data-item-slug],[data-film-slug]")];
  const pick = (year && els.find(e => (e.dataset.itemFullDisplayName || "").includes("(" + year + ")"))) || els[0];
  return pick ? (pick.dataset.itemSlug || pick.dataset.filmSlug) : null;
}

const cleanName = n => (n || "").replace(/\s*\(\d{4}\)\s*$/, "");

function detailSeen() {
  const names = new Map();
  data.films.forEach(f => { const k = norm(cleanName(f.name)); (names.get(k) || names.set(k, []).get(k)).push(f.year); });
  return d => (names.get(norm(d.title)) || []).some(y => !y || !d.year || Math.abs(y - d.year) <= 1);
}

const G = (m, ...gs) => gs.some(g => m.genres.includes(g));
const MOODS = {
  "Classics yet to watch": m => m.rating >= 4 && m.count >= 20000,
  "Old classic (pre-1980)": m => m.year && m.year < 1980,
  "Mind-puzzling thriller": m => G(m, "Thriller", "Mystery"),
  "Weird & surprising": m => G(m, "Fantasy", "Science Fiction", "Horror", "Mystery") && m.count < 250000,
  "Gory horror": m => G(m, "Horror"),
  "Indie vibes": m => m.count < 80000 && m.rating >= 3.4,
  "Cinema history revolutionary": m => m.year && m.year < 1975 && m.rating >= 3.8,
  "Insane cinematography": m => m.rating >= 4,
  "Award winning (Oscars preferred)": m => m.rating >= 3.9 && m.count >= 100000,
  "Rated 4+": m => m.rating >= 4,
  "Insane drama": m => G(m, "Drama") && m.rating >= 3.8,
  "Interesting true story": m => G(m, "History", "Crime", "Documentary", "War") && m.rating >= 3.6,
  "Surprise me": () => true,
};
const WORDS = [
  [/horror|scary|creepy/i, "Horror"], [/thriller|suspense|tense/i, "Thriller"], [/comed|funny|laugh/i, "Comedy"],
  [/romanc|love story/i, "Romance"], [/sci-?fi|science fiction|space|futur/i, "Science Fiction"], [/anim|anime|cartoon/i, "Animation"],
  [/\bwar\b/i, "War"], [/western|cowboy/i, "Western"], [/musical|music/i, "Music"], [/documentar/i, "Documentary"],
  [/crime|gangster|heist/i, "Crime"], [/mystery|detective|whodunit/i, "Mystery"], [/fantasy|magic/i, "Fantasy"],
  [/drama/i, "Drama"], [/histor|period/i, "History"], [/family|kids/i, "Family"],
];

function textPreds(text) {
  const preds = [];
  const gs = WORDS.filter(([re]) => re.test(text)).map(([, g]) => g);
  if (gs.length) preds.push(m => gs.some(g => m.genres.includes(g)));
  const dm = text.match(/\b(19|20)?(\d)0s\b/);
  if (dm) { const start = +((dm[1] || (+dm[2] >= 3 ? "19" : "20")) + dm[2] + "0"); preds.push(m => m.year && m.year >= start && m.year < start + 10); }
  return preds;
}

function whyOf(d) {
  return [d.genres.slice(0, 3).join(" · "), d.rating ? "rated " + d.rating.toFixed(1) + "★ by Letterboxd members" : ""].filter(Boolean).join(", ");
}

async function similarTo(f, ids = ["simBox", "simTitle", "simRecs"], verb = "watched") {
  $(ids[0]).hidden = false; $(ids[1]).textContent = "Finding films like " + f.name + "…"; $(ids[2]).innerHTML = "";
  try {
    const slug = f.slug || await findSlug(f.name, f.year);
    if (!slug) throw new Error("nofilm");
    const seenSlugs = new Set(data.films.map(x => x.slug).filter(Boolean)), seenDetail = detailSeen();
    const list = (await similarList(slug)).filter(s => !seenSlugs.has(s)).slice(0, 14);
    const details = (await pmap(list, getDetails, 7)).filter(d => d && !seenDetail(d)).slice(0, 5);
    $(ids[1]).textContent = "Because you " + verb + " " + f.name;
    renderRecs(details.map(d => ({ ...d, why: whyOf(d) })), false, ids[2]);
  } catch (e) { $(ids[1]).textContent = "Couldn't find similar films right now. Try again."; }
}

async function recommend(append) {
  $("go").disabled = true; $("more").disabled = true;
  try {
    if (!data.films.some(f => f.slug)) { setStatus("Press “Load my films” once more so I can read your film links.", true); return; }
    setStatus("Finding films people with your taste love…");
    const seenSlugs = new Set(data.films.map(f => f.slug).filter(Boolean));
    const seenDetail = detailSeen();
    const wl = new Set((data.watchlist || []).map(f => f.slug).filter(Boolean));
    const sim = $("similar").value.trim();
    let seeds;
    if (sim) {
      const s = await findSlug(sim, null);
      if (!s) { setStatus("Couldn't find “" + sim + "” on Letterboxd.", true); return; }
      seeds = [{ slug: s, name: sim, w: 5 }];
    } else {
      seeds = data.films.filter(f => f.slug && f.rating >= 4)
        .map(f => ({ slug: f.slug, name: cleanName(f.name), w: f.rating, k: f.rating + Math.random() * 1.2 }))
        .sort((a, b) => b.k - a.k).slice(0, 10);
      if (!seeds.length) seeds = data.films.filter(f => f.slug).slice(0, 10).map(f => ({ slug: f.slug, name: cleanName(f.name), w: 4 }));
    }
    const lists = await pmap(seeds, s => similarList(s.slug), 5);
    const score = new Map(), because = new Map();
    lists.forEach((l, i) => (l || []).forEach((slug, r) => {
      if (seenSlugs.has(slug) || shown.includes(slug)) return;
      score.set(slug, (score.get(slug) || 0) + seeds[i].w / (1 + r / 15));
      const b = because.get(slug) || [];
      if (b.length < 2 && !b.includes(seeds[i].name)) b.push(seeds[i].name);
      because.set(slug, b);
    }));
    const moods = [...document.querySelectorAll('.mood[aria-pressed="true"]')].map(b => b.textContent.trim());
    const preds = moods.map(k => MOODS[k]).filter(Boolean).concat(textPreds($("extra").value));
    const maxRt = +$("len").value || 0;
    const rtOk = m => !maxRt || !m.runtime || m.runtime <= maxRt;
    let cands = [...score.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    if (moods.includes("Surprise me")) cands = cands.slice(0, 50).sort(() => Math.random() - 0.5);
    const limit = (preds.length || maxRt) ? 60 : 14;
    const details = (await pmap(cands.slice(0, limit), getDetails, 8)).filter(d => d && !seenDetail(d) && rtOk(d));
    const hits = d => preds.filter(p => p(d)).length;
    let picks = details.filter(d => hits(d) === preds.length), relaxed = false;
    const via = new Map();
    for (let round = 0; round < 2 && picks.length < 6 && preds.length; round++) {
      const from = (picks.length ? picks : details.filter(d => hits(d) > 0)).slice(0, 6);
      if (!from.length) break;
      const more = await pmap(from, d => similarList(d.slug), 5);
      const known = new Set(details.map(d => d.slug)), fresh = [];
      more.forEach((l, i) => (l || []).forEach(s => {
        if (seenSlugs.has(s) || shown.includes(s) || known.has(s) || fresh.some(x => x.s === s)) return;
        fresh.push({ s, from: from[i].title });
      }));
      const nd = (await pmap(fresh.slice(0, 60).map(x => x.s), getDetails, 8)).filter(d => d && !seenDetail(d) && rtOk(d));
      nd.forEach(d => via.set(d.slug, fresh.find(x => x.s === d.slug).from));
      details.push(...nd);
      picks = details.filter(d => hits(d) === preds.length);
    }
    if (picks.length < 6 && preds.length) {
      relaxed = true;
      picks = picks.concat(details.filter(d => !picks.includes(d) && hits(d) > 0).sort((a, b) => hits(b) - hits(a)));
    }
    picks = picks.slice(0, 6);
    if (!picks.length) { setStatus("Nothing matched. Try fewer filters or a longer runtime.", true); return; }
    picks.forEach(d => shown.push(d.slug));
    $("out").hidden = false;
    renderRecs(picks.map(d => ({ ...d, onWatchlist: wl.has(d.slug), because: because.get(d.slug) || [], why: whyOf(d) + (via.has(d.slug) ? ". Similar to " + via.get(d.slug) : "") })), append, "recs");
    setStatus(relaxed ? "Few films matched every filter, so some are close matches." : "");
  } catch (e) { setStatus("Couldn't reach Letterboxd. Try again.", true); }
  finally { updateGo(); $("more").disabled = false; }
}

function renderRecs(list, append, target) {
  const ol = $(target);
  if (!append) ol.innerHTML = "";
  const start = ol.children.length;
  list.forEach((r, k) => {
    const li = document.createElement("li"); li.className = "rec";
    li.innerHTML = '<div class="rank"></div><img class="rp" alt=""><div><h3></h3><div class="meta"></div><p class="why"></p><p class="because"></p><a target="_blank" rel="noopener">Open on Letterboxd ↗</a></div>';
    li.querySelector(".rank").textContent = start + k + 1;
    const im = li.querySelector(".rp");
    if (r.poster) { im.src = r.poster; im.referrerPolicy = "no-referrer"; } else im.remove();
    const h = li.querySelector("h3"); h.textContent = r.title;
    const sm = document.createElement("small"); sm.textContent = r.year || ""; h.append(sm);
    if (r.onWatchlist) { const w = document.createElement("span"); w.className = "wl"; w.textContent = "On your watchlist"; h.append(w); }
    li.querySelector(".meta").textContent = [r.director, r.runtime && r.runtime + " min"].filter(Boolean).join(" · ");
    li.querySelector(".why").textContent = r.why || "";
    li.querySelector(".because").textContent = r.because && r.because.length ? "Because you rated highly: " + r.because.join(", ") : "";
    li.querySelector("a").href = "https://letterboxd.com/film/" + r.slug + "/";
    ol.append(li);
  });
}

/* ---------- Wiring ---------- */
function updateGo() { $("go").disabled = !data; }

document.querySelectorAll(".mood").forEach(b => {
  b.setAttribute("aria-pressed", "false");
  b.onclick = () => b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
});
$("load").onclick = loadProfile;
$("user").addEventListener("keydown", e => { if (e.key === "Enter") loadProfile(); });
$("go").onclick = () => { shown = []; recommend(false); };
$("more").onclick = () => recommend(true);

(async () => {
  const s = await store.get(["user", "cache"]);
  if (s.user) $("user").value = s.user;
  if (s.cache) { data = s.cache; showData(); }
  updateGo();
})();
