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
    if (!keys.has(k) && out.length < 20) { keys.add(k); out.push(f); }
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
    if (!recent.length) recent = films.slice(0, 20).map(f => ({ ...f, date: "" }));
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
  if (f.poster) { const im = document.createElement("img"); im.src = f.poster; im.alt = ""; im.loading = "eager"; im.referrerPolicy = "no-referrer"; b.append(im); }
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
      dirUrl: (() => { const d0 = (ld.director || [])[0] || {}; const u = String(d0.sameAs || d0.url || ""); return u.replace(/^https?:\/\/letterboxd\.com/, ""); })(),
      castUrls: [...doc.querySelectorAll('.cast-list a[href^="/actor/"]')].map(a => a.getAttribute("href")).slice(0, 3),
      desc: (() => { const ps = [...new Set([...doc.querySelectorAll(".production-synopsis p")].map(p => p.textContent.replace(/\s+/g, " ").trim()).filter(Boolean))]; return ps.length ? ps.join(" ") : ((doc.querySelector('meta[name="description"]') || {}).content || "").replace(/\s+/g, " ").trim(); })(),
      themes: [...new Set([...doc.querySelectorAll('a[href*="/films/theme/"],a[href*="/films/mini-theme/"]')].map(a => a.textContent.replace(/\s+/g, " ").trim()).filter(t => t && t.length < 70))].slice(0, 6),
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
const GORE = /gore|gory|slasher|splatter|blood|body horror|torture|brutal|massacre|mutilat|cannibal|dismember|violen/i;
const MOODS = {
  "1001 Movies You Must See Before You Die": () => true,
  "The Ultimate Film Studies": () => true,
  "Revolutionary / cinema history": m => m.year && m.year < 1975 && m.rating >= 3.8,
  "Beautiful cinematography": m => m.rating >= 4,
  "Award winning": () => true,
  "Drama": m => G(m, "Drama") && m.rating >= 3.6,
  "Thriller": m => G(m, "Thriller"),
  "Horror": () => true,
  "Gory horror": m => G(m, "Horror") && GORE.test((m.desc || "") + " " + (m.themes || []).join(" ")),
  "Comedy": m => G(m, "Comedy"),
  "Satire": m => /satir|parod|spoof|send-up|mockumentary|lampoon/i.test((m.desc || "") + " " + (m.themes || []).join(" ")),
  "Rom-com": m => (m.genres || []).includes("Romance") && (m.genres || []).includes("Comedy"),
  "Sci-fi": m => G(m, "Science Fiction"),
  "Documentary": () => true,
  "Indie": m => m.count < 80000 && m.rating >= 3.4,
  "Based on a true story": m => G(m, "History", "Crime", "Documentary", "War") && m.rating >= 3.6,
  "Letterboxd's Top 500 Films": () => true,
  "What is reality?": () => true,
  "Good Films, 90 Minutes or Less": () => true,
  "Feeling lost in your 20\u2019s": () => true,
  "Chick flicks": () => true,
  "Hopeless cinema": () => true,
  "Coming-of-age": () => true,
  "A24": () => true,
  "Independent film studio": () => true,
  "Weird and unexpected": m => G(m, "Fantasy", "Science Fiction", "Horror", "Mystery") && m.count < 250000,
  "3.5★+": m => m.rating >= 3.5,
  "4★+": m => m.rating >= 4,
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
  return d.genres && d.genres.length ? "Genres: " + d.genres.slice(0, 3).join(" · ") : "";
}

async function similarTo(f, ids = ["simBox", "simTitle", "simRecs"], verb = "watched") {
  $(ids[0]).hidden = false; ensureClose($(ids[0]), ids); $(ids[1]).textContent = "Finding films like " + f.name + "…"; $(ids[2]).innerHTML = "";
  try {
    const slug = f.slug || await findSlug(f.name, f.year);
    if (!slug) throw new Error("nofilm");
    const seenSlugs = new Set(data.films.map(x => x.slug).filter(Boolean)), seenDetail = detailSeen();
    const list = (await relatedSlugs(slug)).filter(s => !seenSlugs.has(s) && s !== slug).slice(0, 60);
    const details = (await pmap(list, getDetails, 7)).filter(d => d && !seenDetail(d)).slice(0, 52);
    $(ids[1]).textContent = "Because you " + verb + " " + f.name;
    const sd = await getDetails(slug).catch(() => null);
    const docSeed = !!(sd && (sd.genres || []).includes("Documentary"));
    const shownD = docSeed ? details.filter(d => (d.genres || []).includes("Documentary")) : details;
    renderRecs(shownD.map(d => ({ ...d, why: whyOf(d), fit: fitSim(d, sd, f.name) })), false, ids[2]);
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
    const moodP = moods.map(k => MOODS[k]).filter(Boolean);
    const textP = textPreds($("extra").value);
    const preds = moodP.concat(textP);
    const canon = await canonCandidates($("extra").value, moods).catch(() => []);
    const canonMap = new Map(canon.map(c => [c.slug, c.note]));
    const dirName = ($("director").value || "").trim();
    let dirList = [];
    if (dirName) {
      const dl = await directorFilms(dirName).catch(() => null);
      if (!dl || !dl.slugs.length) { setStatus("Couldn\u2019t find a director called \u201c" + dirName + "\u201d.", true); return; }
      dirList = dl.slugs; dl.slugs.forEach(s => canonMap.set(s, "is a film by " + dl.name + ", the director you picked"));
    }
    const maxRt = +$("len").value || 0;
    const dec = +$("decade").value || 0;
    const rtOk = m => (!maxRt || !m.runtime || m.runtime <= maxRt) && (!dec || (m.year && (dec < 0 ? m.year < 1920 : (m.year >= dec && m.year < dec + 10))));
    let cands = [...score.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    if (moods.includes("Surprise me")) cands = cands.slice(0, 50).sort(() => Math.random() - 0.5);
    { const cs = canon.map(c => c.slug).filter(s => !seenSlugs.has(s)); cands = cs.concat(cands.filter(s => !cs.includes(s))); }
    if (dirList.length) cands = dirList.filter(s => !seenSlugs.has(s));
    else if (dec && DECADE_SEEDS[dec]) { const ds = DECADE_SEEDS[dec].filter(s => !seenSlugs.has(s)); cands = ds.concat(cands.filter(s => !ds.includes(s))); }
    const srcMoods = moods.filter(k => MOOD_SOURCES[k]);
    if (srcMoods.length && !dirList.length) {
      setStatus("Searching the " + srcMoods.join(" + ") + " list\u2026");
      const arrs = await Promise.all(srcMoods.map(k => sourceSlugs(k).catch(() => [])));
      const sl = [...new Set(arrs.flat())].filter(s => !seenSlugs.has(s)).sort(() => Math.random() - 0.5);
      srcMoods.forEach((k, ix) => (arrs[ix] || []).forEach(s => { if (!canonMap.has(s)) canonMap.set(s, MOOD_SOURCES[k].note); }));
      if (sl.length) cands = sl;
    }
    const limit = (preds.length || maxRt || dec || canon.length || dirList.length) ? 60 : 14;
    const details = (await pmap(cands.slice(0, limit), getDetails, 8)).filter(d => d && !seenDetail(d) && rtOk(d));
    const hits = d => canonMap.has(d.slug) ? moodP.filter(p => p(d)).length + textP.length : preds.filter(p => p(d)).length;
    let picks = details.filter(d => hits(d) === preds.length), relaxed = false;
    const via = new Map();
    for (let round = 0; round < 2 && picks.length < 6 && preds.length && !dirList.length && !srcMoods.length; round++) {
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
    renderRecs(picks.map(d => ({ ...d, onWatchlist: wl.has(d.slug), because: because.get(d.slug) || [], note: canonMap.get(d.slug) || "", why: whyOf(d) + (via.has(d.slug) ? ". Similar to " + via.get(d.slug) : "") })), append, "recs");
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
    li.dataset.rating = r.rating || 0;
    li.dataset.idx = start + k;
    li.dataset.slug = r.slug || "";
    li.innerHTML = '<div class="rank"></div><img class="rp" alt=""><div><h3></h3><div class="meta"></div><p class="desc"></p><p class="why"></p><p class="themes"></p><p class="rated"></p><p class="fit"></p><p class="because"></p><a target="_blank" rel="noopener">Open on Letterboxd ↗</a></div>';
    li.querySelector(".rank").textContent = start + k + 1;
    const im = li.querySelector(".rp");
    if (r.poster) { im.src = r.poster; im.referrerPolicy = "no-referrer"; } else im.remove();
    const h = li.querySelector("h3"); h.textContent = r.title;
    const sm = document.createElement("small"); sm.textContent = r.year || ""; h.append(sm);
    if (r.onWatchlist) { const w = document.createElement("span"); w.className = "wl"; w.textContent = "On your watchlist"; h.append(w); }
    li.querySelector(".meta").textContent = [r.director, r.runtime && r.runtime + " min"].filter(Boolean).join(" · ");
    li.querySelector(".desc").textContent = r.desc || "";
    li.querySelector(".why").textContent = r.why || "";
    li.querySelector(".rated").remove();
    if (r.rating) { const bd = document.createElement("div"); bd.className = "ratebadge"; bd.title = "Letterboxd members' average rating"; bd.textContent = Number(r.rating).toFixed(1) + " \u2605"; const wr = document.createElement("div"); wr.className = "ratewrap"; wr.append(bd); li.append(wr); }
    { const tl = li.querySelector(".themes"); let s = ""; (r.themes || []).slice(0, 3).forEach(t => { const n = s ? s + " \u00b7 " + t : t; if (!s || n.length <= 88) s = n; }); if (s) tl.textContent = "Themes: " + s; else tl.remove(); }
    li.querySelector(".fit").innerHTML = "";
    { const ft = r.fit || (target === "recs" ? fitFor(r) : ""); if (ft) { const b = document.createElement("b"); b.textContent = "Why you'll like it: "; li.querySelector(".fit").append(b, document.createTextNode(ft)); } else li.querySelector(".fit").remove(); }
    li.querySelector(".because").textContent = r.because && r.because.length ? "Because you rated highly: " + r.because.join(", ") : "";
    li.querySelector("a").href = "https://letterboxd.com/film/" + r.slug + "/";
    ol.append(li);
  });
  if (target === "recs") applyRecFilter(); else ensureFilter(ol);
  decorateCrowns();
}

/* ---------- Wiring ---------- */
function updateGo() { $("go").disabled = !data; $("surprise").disabled = !data; }

document.querySelectorAll(".mood").forEach(b => {
  b.setAttribute("aria-pressed", "false");
  b.onclick = () => { const sm = document.getElementById("surpriseMood"); if (sm && b !== sm) sm.setAttribute("aria-pressed", "false"); b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true"); };
});
$("load").onclick = loadProfile;
$("user").addEventListener("keydown", e => { if (e.key === "Enter") loadProfile(); });
$("go").onclick = () => { $("surpriseMood").setAttribute("aria-pressed", "false"); shown = []; recommend(false); };
$("surprise").onclick = () => { document.querySelectorAll(".mood").forEach(x => x.setAttribute("aria-pressed", "false")); $("surpriseMood").setAttribute("aria-pressed", "true"); shown = []; recommend(false); };
$("more").onclick = () => recommend(true);

(async () => {
  const s = await store.get(["user", "cache"]);
  updateGo();
})();

let recMin = 0;
function applyRecFilter() {
  const items = [...document.querySelectorAll("#recs .rec")];
  let n = 0;
  items.forEach(li => { const ok = Number(li.dataset.rating) >= recMin; li.hidden = !ok; if (ok) n++; });
  const none = document.getElementById("recNone");
  if (none) none.hidden = n > 0 || !items.length;
}
document.querySelectorAll(".rf").forEach(btn => btn.addEventListener("click", () => {
  recMin = Number(btn.dataset.min);
  document.querySelectorAll(".rf").forEach(x => x.setAttribute("aria-pressed", String(x === btn)));
  applyRecFilter();
}));
document.getElementById("clear").addEventListener("click", () => {
  document.getElementById("recs").innerHTML = "";
  document.getElementById("out").hidden = true;
  shown = [];
  window.scrollTo({ top: 0, behavior: "smooth" });
});
document.querySelectorAll(".scrollbtn").forEach(btn => btn.addEventListener("click", () => {
  const r = document.getElementById("recent");
  r.scrollBy({ left: Number(btn.dataset.dir) * r.clientWidth * 0.8, behavior: "smooth" });
}));

function fitSim(d, sd, name) {
  const parts = [];
  const sg = sd ? (sd.genres || []).filter(x => (d.genres || []).includes(x)) : [];
  if (sg.length) parts.push("shares the " + sg.slice(0, 3).join("/").toLowerCase() + " feel of " + name);
  else parts.push("is a close neighbour of " + name + " in what Letterboxd members watch");
  if (sd && sd.director && d.director && sd.director.split(", ").some(x => d.director.split(", ").includes(x))) parts.push("it is by the same director, " + d.director.split(", ")[0]);
  if (d.rating) parts.push("members rate it " + d.rating.toFixed(1) + "\u2605" + (sd && sd.rating && d.rating >= sd.rating ? ", even higher than " + name : ""));
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() === s.charAt(0) ? s + "." : s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
function fitFor(r) {
  const moods = [...document.querySelectorAll(".mood")].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.textContent.trim()).filter(x => x !== "Surprise me");
  const text = ($("extra").value || "").trim();
  const sim = ($("similar").value || "").trim();
  const parts = [];
  if (r.note) parts.push(r.note);
  if (text) parts.push("fits what you described (\u201c" + (text.length > 50 ? text.slice(0, 50) + "\u2026" : text) + "\u201d)");
  if (moods.length) parts.push("ticks your " + moods.join(" + ").toLowerCase() + " pick");
  if (sim) parts.push("is close to " + sim);
  if (r.because && r.because.length) parts.push("is loved by fans of " + r.because.slice(0, 2).join(" and ") + ", which you rated highly");
  else if (!parts.length && r.genres && r.genres.length) parts.push("is a " + r.genres.slice(0, 2).join("/").toLowerCase() + " pick that suits your highly rated films");
  if (!parts.length) return "";
  const s = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
function ensureFilter(ol) {
  let bar = ol.previousElementSibling;
  if (!(bar && bar.classList.contains("rfbar"))) {
    bar = document.createElement("div"); bar.className = "rfbar";
    bar.innerHTML = '<button type="button" class="ghost rfx" data-min="0" aria-pressed="true">All</button><button type="button" class="ghost rfx" data-min="3.5" aria-pressed="false">3.5\u2605+</button><button type="button" class="ghost rfx" data-min="4" aria-pressed="false">4\u2605+</button><span class="rfn"></span>';
    ol.before(bar);
    bar.querySelectorAll(".rfx").forEach(btn => btn.addEventListener("click", () => {
      bar.querySelectorAll(".rfx").forEach(x => x.setAttribute("aria-pressed", String(x === btn)));
      const min = Number(btn.dataset.min); let n = 0;
      const items = [...ol.querySelectorAll(".rec")];
      items.forEach(li => { const ok = Number(li.dataset.rating) >= min; li.hidden = !ok; if (ok) n++; });
      bar.querySelector(".rfn").textContent = n || !items.length ? "" : "No films here reach that rating";
    }));
  } else {
    bar.querySelectorAll(".rfx").forEach((x, i) => x.setAttribute("aria-pressed", String(i === 0)));
    bar.querySelector(".rfn").textContent = "";
  }
}
{
  const _sd = showData;
  showData = function () {
    _sd.apply(this, arguments);
    const w = document.getElementById("welcome");
    if (w && data && data.user) {
      w.textContent = "Welcome back, ";
      const u = document.createElement("u"); u.textContent = data.user;
      w.append(u, document.createTextNode(". Here\u2019s what you\u2019ve been watching\u2026"));
      w.hidden = false;
    }
  };
  if (data) showData();
}

function fitSim(d, sd, name) {
  const parts = [];
  const sg = sd ? (sd.genres || []).filter(x => (d.genres || []).includes(x)) : [];
  const st = sd ? (d.themes || []).filter(x => (sd.themes || []).includes(x)) : [];
  if (st.length) parts.push("shares themes with " + name + ": " + st.slice(0, 2).join(" and ").toLowerCase());
  else if (sg.length) parts.push("has the same " + sg.slice(0, 3).join("/").toLowerCase() + " pull as " + name);
  else parts.push("is a close neighbour of " + name + " for Letterboxd viewers");
  if (sd && sd.director && d.director && sd.director.split(", ").some(x => d.director.split(", ").includes(x))) parts.push("comes from the same director, " + d.director.split(", ")[0]);
  else if (!st.length && d.themes && d.themes.length) parts.push("leans into " + d.themes[0].toLowerCase());
  const s = parts.join(" and ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
function fitFor(r) {
  const moods = [...document.querySelectorAll(".mood")].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.textContent.trim()).filter(x => x !== "Surprise me" && !(r.note && MOOD_SOURCES[x]));
  const text = ($("extra").value || "").trim();
  const sim = ($("similar").value || "").trim();
  const parts = [];
  if (r.note) parts.push(r.note);
  if (text) parts.push("fits what you described (\u201c" + (text.length > 50 ? text.slice(0, 50) + "\u2026" : text) + "\u201d)");
  if (moods.length) parts.push("delivers on your " + moods.join(" + ").toLowerCase() + " pick");
  if (sim) parts.push("is close in feel to " + sim);
  if (r.because && r.because.length) parts.push("is loved by fans of " + r.because.slice(0, 2).join(" and ") + ", which you rated highly");
  if (r.themes && r.themes.length) parts.push("explores " + r.themes[0].toLowerCase());
  if (!parts.length && r.genres && r.genres.length) parts.push("is a " + r.genres.slice(0, 2).join("/").toLowerCase() + " pick that suits your highly rated films");
  if (!parts.length) return "";
  const s = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
function applyFilter(ol, min, limit) {
  const items = [...ol.querySelectorAll(".rec")];
  items.sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
  let n = 0;
  items.forEach(li => {
    ol.append(li);
    const ok = Number(li.dataset.rating) >= min && (!limit || n < limit);
    li.hidden = !ok;
    if (ok) { n++; li.querySelector(".rank").textContent = n; }
  });
  return n;
}
function applyRecFilter() {
  const ol = document.getElementById("recs");
  const n = applyFilter(ol, recMin, 0);
  const none = document.getElementById("recNone");
  if (none) none.hidden = n > 0 || !ol.querySelector(".rec");
}
function ensureFilter(ol) {
  let bar = ol.previousElementSibling;
  if (!(bar && bar.classList.contains("rfbar"))) {
    bar = document.createElement("div"); bar.className = "rfbar";
    bar.innerHTML = '<button type="button" class="ghost rfx" data-min="0" aria-pressed="true">Most similar</button><button type="button" class="ghost rfx" data-min="3.5" aria-pressed="false">3.5\u2605+</button><button type="button" class="ghost rfx" data-min="4" aria-pressed="false">4\u2605+</button><span class="rfn"></span>';
    ol.before(bar);
    bar.querySelectorAll(".rfx").forEach(btn => btn.addEventListener("click", () => {
      bar.querySelectorAll(".rfx").forEach(x => x.setAttribute("aria-pressed", String(x === btn)));
      const n = applyFilter(ol, Number(btn.dataset.min), 4);
      bar.querySelector(".rfn").textContent = n || !ol.querySelector(".rec") ? "" : "No films here reach that rating";
    }));
  } else {
    bar.querySelectorAll(".rfx").forEach((x, i) => x.setAttribute("aria-pressed", String(i === 0)));
    bar.querySelector(".rfn").textContent = "";
  }
  applyFilter(ol, 0, 4);
}
function ensureClose(box, ids) {
  if (box.querySelector(".xbtn")) return;
  const x = document.createElement("button");
  x.type = "button"; x.className = "xbtn"; x.setAttribute("aria-label", "Close"); x.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  x.onclick = () => {
    const ol = document.getElementById(ids[2]);
    const bar = ol.previousElementSibling; if (bar && bar.classList.contains("rfbar")) bar.remove();
    ol.innerHTML = ""; box.hidden = true;
    document.querySelectorAll('.favcard[aria-pressed="true"], .rfilm[aria-pressed="true"]').forEach(b => b.setAttribute("aria-pressed", "false"));
    box.parentElement.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  box.prepend(x);
}

async function listFrom(url) {
  const doc = parseDoc(await getText(url));
  const out = [], seen = new Set();
  doc.querySelectorAll("[data-item-slug],[data-film-slug]").forEach(el => {
    const s = el.dataset.itemSlug || el.dataset.filmSlug;
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  });
  return out;
}
async function relatedSlugs(slug) {
  const sim = await similarList(slug).catch(() => []);
  const sd = await getDetails(slug).catch(() => null);
  let extra = [];
  if (sd && sd.dirUrl) extra = (await listFrom("https://letterboxd.com" + sd.dirUrl).catch(() => [])).slice(0, 12);
  let out = [...new Set([...sim.slice(0, 30), ...extra, ...sim.slice(30)])];
  if (sd && (sd.genres || []).includes("Documentary")) out = [...new Set([...sim.slice(0, 20), ...(await docPool().catch(() => [])), ...out])];
  if (out.length < 20 && sd) {
    for (const u of (sd.castUrls || [])) {
      const l = await listFrom("https://letterboxd.com" + u).catch(() => []);
      out = [...new Set([...out, ...l.slice(0, 10)])];
    }
  }
  return out;
}
const DIRECTORS = { hitchcock: "alfred-hitchcock", kubrick: "stanley-kubrick", tarantino: "quentin-tarantino", nolan: "christopher-nolan", scorsese: "martin-scorsese", lynch: "david-lynch", kurosawa: "akira-kurosawa", bergman: "ingmar-bergman", fellini: "federico-fellini", godard: "jean-luc-godard", truffaut: "francois-truffaut", tarkovsky: "andrei-tarkovsky", "wes anderson": "wes-anderson", coppola: "francis-ford-coppola", spielberg: "steven-spielberg", villeneuve: "denis-villeneuve", fincher: "david-fincher", polanski: "roman-polanski", "wong kar-wai": "wong-kar-wai", "bong joon-ho": "bong-joon-ho", "park chan-wook": "park-chan-wook", almodovar: "pedro-almodovar", haneke: "michael-haneke", "von trier": "lars-von-trier", cronenberg: "david-cronenberg", kieslowski: "krzysztof-kieslowski", varda: "agnes-varda", ozu: "yasujiro-ozu", miyazaki: "hayao-miyazaki", herzog: "werner-herzog", wenders: "wim-wenders", welles: "orson-welles", chaplin: "charlie-chaplin", eisenstein: "sergei-m-eisenstein", godzilla: "ishiro-honda" };
const CANON = [
  ["vertigo", "hitchcock revolutionary technique dolly zoom camera important director changed cinema game innovative suspense", "pioneered the dolly zoom, the camera technique Hitchcock made famous"],
  ["psycho", "hitchcock revolutionary technique editing shower important director changed cinema game innovative horror shocking", "changed cinema with its shower-scene editing and by killing off its star early"],
  ["rope", "hitchcock revolutionary technique long take single take important director changed cinema game innovative experimental", "was staged to look like one unbroken take, an experiment only Hitchcock tried"],
  ["rear-window", "hitchcock technique camera voyeur important director changed cinema innovative suspense", "turns one apartment window into a masterclass in point-of-view suspense"],
  ["north-by-northwest", "hitchcock technique important director changed cinema innovative suspense chase", "invented the modern set-piece thriller with the crop-duster chase"],
  ["the-birds", "hitchcock technique sound design important director changed cinema innovative horror", "built terror from silence and sound design instead of a score"],
  ["citizen-kane", "welles revolutionary technique deep focus important director changed cinema game innovative cinematography nonlinear", "changed cinema with deep-focus photography and a fractured, non-linear structure"],
  ["touch-of-evil", "welles technique long take important director changed cinema innovative noir cinematography", "opens with one of cinema's most famous long takes"],
  ["breathless", "godard new wave revolutionary technique jump cut important director changed cinema game innovative", "popularised the jump cut and kicked off the French New Wave"],
  ["the-400-blows", "truffaut new wave important director changed cinema innovative freeze frame", "helped launch the French New Wave with a raw, personal style"],
  ["battleship-potemkin", "eisenstein revolutionary technique montage editing silent important director changed cinema game innovative", "established montage editing as a language of film"],
  ["man-with-a-movie-camera", "vertov revolutionary technique experimental editing silent important director changed cinema innovative documentary", "throws every camera trick in the book into one silent experiment"],
  ["2001-a-space-odyssey", "kubrick revolutionary technique special effects important director changed cinema game innovative scifi", "rewrote what visual effects and slow, wordless storytelling could do"],
  ["the-shining", "kubrick technique steadicam important director changed cinema innovative horror", "made the Steadicam a storytelling tool"],
  ["a-clockwork-orange", "kubrick important director changed cinema innovative", "mixed style and provocation in a way that changed what cinema dared to show"],
  ["metropolis", "lang revolutionary technique special effects silent expressionism important director changed cinema game innovative scifi", "set the template for screen science fiction with its effects and design"],
  ["the-cabinet-of-dr-caligari", "expressionism revolutionary technique silent important director changed cinema innovative horror", "defined German Expressionism with its painted, distorted sets"],
  ["nosferatu", "murnau expressionism technique silent important director changed cinema innovative horror", "invented much of the visual language of screen horror"],
  ["sunrise-a-song-of-two-humans", "murnau technique camera silent important director changed cinema innovative", "set free the moving camera in the silent era"],
  ["rashomon", "kurosawa revolutionary technique narrative multiple perspectives important director changed cinema game innovative", "introduced the multiple-perspectives structure copied ever since"],
  ["seven-samurai", "kurosawa technique action ensemble important director changed cinema innovative", "wrote the blueprint for the modern team-up action film"],
  ["persona", "bergman experimental technique important director changed cinema innovative", "broke the fourth wall of cinema itself"],
  ["a-trip-to-the-moon", "melies revolutionary technique special effects silent important director changed cinema game innovative scifi", "invented film special effects in 1902"],
  ["the-passion-of-joan-of-arc", "dreyer technique close-up silent important director changed cinema innovative", "made the close-up an engine of emotion"],
  ["un-chien-andalou", "bunuel surrealism experimental technique silent important director changed cinema innovative", "brought surrealism to the screen"],
  ["bicycle-thieves", "de sica neorealism important director changed cinema innovative", "launched Italian neorealism with real streets and non-actors"],
  ["stalker", "tarkovsky technique slow cinema important director changed cinema innovative", "turned time itself into a cinematic material"],
  ["the-matrix", "revolutionary technique bullet time special effects changed cinema game innovative scifi", "popularised bullet time and changed action cinema"],
  ["jaws", "spielberg technique blockbuster important director changed cinema game innovative suspense", "invented the summer blockbuster"],
  ["the-godfather", "coppola important director changed cinema game innovative cinematography", "redefined American film with its dark, painterly look"],
  ["apocalypse-now", "coppola technique important director changed cinema innovative war sound design", "pushed war cinema into hallucination and immersive sound"],
  ["children-of-men", "cuaron technique long take camera important director changed cinema innovative", "uses long takes so immersive they changed how action is shot"],
  ["russian-ark", "sokurov revolutionary technique single take experimental important director changed cinema innovative", "was shot as one continuous 96-minute take"],
  ["run-lola-run", "tykwer technique editing experimental changed cinema innovative", "told one story three ways at breakneck speed"],
  ["memento", "nolan technique nonlinear structure important director changed cinema innovative", "told its story backwards, changing how puzzle films work"],
  ["pulp-fiction", "tarantino technique nonlinear structure important director changed cinema game innovative", "scrambled its timeline and reset 90s independent film"],
  ["the-wizard-of-oz", "technicolor technique changed cinema innovative", "used Technicolor as part of the storytelling"],
  ["tokyo-story", "ozu technique important director changed cinema innovative", "perfected the low, still camera that defines Ozu"],
  ["pather-panchali", "ray important director changed cinema innovative neorealism", "introduced Indian cinema to the world"],
  ["the-battle-of-algiers", "pontecorvo technique documentary style important director changed cinema innovative", "faked newsreel realism so well it was studied by real armies"],
  ["jeanne-dielman-23-quai-du-commerce-1080-bruxelles", "akerman technique slow cinema important director changed cinema innovative", "turned real-time domestic routine into a landmark"],
  ["toy-story", "pixar revolutionary technique computer animation changed cinema game innovative", "was the first fully computer-animated feature"],
  ["snow-white-and-the-seven-dwarfs", "disney revolutionary technique animation changed cinema game innovative", "proved a feature-length animated film could work"],
  ["avatar", "cameron revolutionary technique 3d motion capture special effects changed cinema game innovative scifi", "pushed 3D and performance capture into the mainstream"],
  ["star-wars", "lucas revolutionary technique special effects changed cinema game innovative scifi", "redefined special effects and the blockbuster"],
  ["the-blair-witch-project", "revolutionary technique found footage changed cinema game innovative horror", "launched the found-footage horror wave"],
  ["spider-man-into-the-spider-verse", "revolutionary technique animation style changed cinema game innovative", "invented a comic-book animation look that others now copy"],
  ["the-jazz-singer", "revolutionary technique sound talkie changed cinema game innovative", "brought sound to mainstream film"],
  ["m", "lang technique sound important director changed cinema innovative thriller", "pioneered the use of sound as a plot device"],
  ["the-general", "keaton technique silent stunts important director changed cinema innovative comedy", "built physical comedy into a cinematic spectacle"]
];
const STOPW = new Set("a an the of and or to in on at by for with that this was is are it its who which from as be been new into than then very more most much film films movie movies i want something like about me my some good one when what where how you your".split(" "));
function pfx(w) { return w.slice(0, 6); }
async function canonCandidates(text, moods) {
  let t = (text || "").toLowerCase();
  if ((moods || []).includes("Revolutionary / cinema history")) t += " revolutionary changed cinema";
  const words = t.split(/[^a-z\u00c0-\u017f]+/).filter(w => w.length > 2 && !STOPW.has(w));
  const toks = new Set(words.map(pfx));
  if (!toks.size) return [];
  const named = Object.keys(DIRECTORS).filter(k => new RegExp("\\b" + k.replace(/-/g, "[- ]") + "\\b").test(t));
  const out = [];
  const scored = CANON.map(([slug, tags, note], i) => {
    let sc = 0;
    new Set(tags.split(" ").map(pfx)).forEach(w => { if (toks.has(w)) sc++; });
    named.forEach(k => { if (tags.includes(k.split(" ").pop().split("-")[0])) sc += 5; });
    return { slug, note, sc, i };
  }).filter(x => x.sc >= 3).sort((a, b) => b.sc - a.sc || a.i - b.i);
  scored.slice(0, 14).forEach(x => out.push({ slug: x.slug, note: x.note }));
  for (const k of named) {
    const nm = k.replace(/\b\w/g, c => c.toUpperCase());
    const l = await listFrom("https://letterboxd.com/director/" + DIRECTORS[k] + "/").catch(() => []);
    l.slice(0, 14).forEach(s => { if (!out.some(o => o.slug === s)) out.push({ slug: s, note: "is a " + nm + " film, the director you named" }); });
  }
  return out;
}

{ const clearUser = () => { if (!data) $("user").value = ""; }; clearUser(); window.addEventListener("pageshow", clearUser); setTimeout(clearUser, 300); }

async function directorFilms(name) {
  const key = name.toLowerCase().trim();
  let slug = null;
  const hit = Object.keys(DIRECTORS).find(k => k === key || k.split(" ").pop() === key);
  if (hit) slug = DIRECTORS[hit];
  else {
    const d = parseDoc(await getText("https://letterboxd.com/s/search/cast-crew/" + encodeURIComponent(name) + "/"));
    const a = [...d.querySelectorAll('a[href^="/director/"]')][0];
    if (a) slug = a.getAttribute("href").split("/")[2];
  }
  if (!slug) return null;
  const p1 = await listFrom("https://letterboxd.com/director/" + slug + "/").catch(() => []);
  const p2 = await listFrom("https://letterboxd.com/director/" + slug + "/page/2/").catch(() => []);
  return { name: slug.replace(/-/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()), slugs: [...new Set([...p1, ...p2])] };
}

const DECADE_SEEDS = {
  "-1": ["a-trip-to-the-moon", "the-great-train-robbery", "cabiria", "the-student-of-prague-1913", "les-vampires", "the-adventurer-1917", "shoulder-arms", "easy-street", "traffic-in-souls", "the-lonely-villa"],
  "1920": ["the-golem-1920", "the-gold-rush", "sherlock-jr", "the-last-laugh", "safety-last", "the-general", "la-roue", "nanook-of-the-north", "greed", "nosferatu", "metropolis", "battleship-potemkin", "the-passion-of-joan-of-arc"],
  "1930": ["city-lights", "m", "modern-times", "frankenstein-1931", "dracula-1931", "vampyr", "zero-de-conduite", "it-happened-one-night", "the-thin-man", "top-hat", "stagecoach", "mr-smith-goes-to-washington", "the-adventures-of-robin-hood", "ninotchka", "bringing-up-baby"]
};

async function docPool() {
  if (window.__docPool) return window.__docPool;
  const top = data.films.filter(f => f.slug && f.rating >= 3.5).slice(0, 60);
  const ds = await pmap(top, f => getDetails(f.slug), 8);
  const docs = top.filter((f, i) => ds[i] && (ds[i].genres || []).includes("Documentary")).slice(0, 6);
  const lists = await pmap(docs, f => similarList(f.slug), 4);
  window.__docPool = [...new Set(lists.flat().filter(Boolean))];
  return window.__docPool;
}
async function pagedSlugs(url, maxPages) {
  const first = parseDoc(await getText(url));
  const pick = d => [...d.querySelectorAll("[data-item-slug],[data-film-slug]")].map(e => e.dataset.itemSlug || e.dataset.filmSlug).filter(Boolean);
  const n = parseInt((first.querySelector(".paginate-pages li:last-child a") || {}).textContent) || 1;
  const all = []; for (let p = 1; p <= n; p++) all.push(p);
  const chosen = all.sort(() => Math.random() - 0.5).slice(0, maxPages);
  const got = await pmap(chosen, p => p === 1 ? Promise.resolve(pick(first)) : getText(url + "page/" + p + "/").then(t => pick(parseDoc(t))), 3);
  return got.filter(Boolean).flat();
}
const CINE_EXTRA = ["days-of-heaven", "barry-lyndon", "in-the-mood-for-love", "come-and-see", "the-tree-of-life", "ran", "hero-2002", "the-assassin-2015", "stalker", "2001-a-space-odyssey", "lawrence-of-arabia", "blade-runner-2049", "the-revenant-2015", "roma-2018", "wings-of-desire", "the-fall-2006", "melancholia", "phantom-thread", "portrait-of-a-lady-on-fire", "the-grand-budapest-hotel", "apocalypse-now", "the-godfather", "citizen-kane", "sunrise-a-song-of-two-humans", "the-conformist", "mulholland-drive", "2046", "happy-together", "the-red-shoes", "black-narcissus", "au-hasard-balthazar", "tokyo-story", "the-spirit-of-the-beehive", "paris-texas"];
const MOOD_SOURCES = {
  "1001 Movies You Must See Before You Die": { urls: ["https://letterboxd.com/gubarenko/list/1001-movies-you-must-see-before-you-die-2021/"], pages: 3, note: "is on the 1001 Movies You Must See Before You Die list" },
  "The Ultimate Film Studies": { urls: ["https://letterboxd.com/ganyyy/list/the-ultimate-film-studies-watchlist-expanded/"], pages: 2, note: "is on the Ultimate Film Studies watchlist" },
  "Beautiful cinematography": { urls: ["https://letterboxd.com/oscars/list/oscar-winning-films-cinematography/"], extra: CINE_EXTRA, pages: 2, note: "is celebrated for its cinematography" },
  "Award winning": { urls: ["https://letterboxd.com/oscars/list/oscar-winning-films-best-picture/", "https://letterboxd.com/darrencb/list/palme-dor-winners-ranked-1/"], pages: 2, note: "won a Best Picture Oscar or the Palme d\u2019Or" },
  "Letterboxd's Top 500 Films": { urls: ["https://letterboxd.com/official/list/letterboxds-top-500-films/"], pages: 3, note: "is in Letterboxd\u2019s Top 500 Films" },
  "Horror": { urls: ["https://letterboxd.com/browsehorror/list/horror-movies-everyone-should-watch-at-least/"], pages: 3, note: "is on a list of horror films everyone should watch" },
  "What is reality?": { urls: ["https://letterboxd.com/tediously_brief/list/what-is-reality/", "https://letterboxd.com/magrosleau/list/psychosexual-dramas-nihilistic-fever-dreams/", "https://letterboxd.com/andredenervaux/list/youre-not-the-same-person-once-the-film-has/"], pages: 3, note: "is on a list of films that blur reality and identity" },
  "Good Films, 90 Minutes or Less": { urls: ["https://letterboxd.com/stautis/list/good-films-90-minutes-or-less/"], pages: 3, note: "is a good film that runs 90 minutes or less" },
  "Feeling lost in your 20\u2019s": { urls: ["https://letterboxd.com/adaydreaming/list/feeling-lost-in-your-20s/"], pages: 3, note: "is on a list of films for feeling lost in your 20s" },
  "Chick flicks": { urls: ["https://letterboxd.com/marialuisacctc/list/women-have-superior-taste-that-is-why-these/"], pages: 3, note: "is on a chick-flick list" },
  "Hopeless cinema": { urls: ["https://letterboxd.com/darrencb/list/the-world-is-hell-hopeless-cinema/"], pages: 3, note: "is on a list of hopeless cinema" },
  "Coming-of-age": { urls: ["https://letterboxd.com/moviemaestro/list/teenage-wasteland-a-comprehensive-list-of/"], pages: 3, note: "is on a coming-of-age list" },
  "Documentary": { urls: ["https://letterboxd.com/official/list/top-250-documentary-films/"], pages: 3, note: "is in Letterboxd\u2019s top documentary films" },
  "A24": { urls: ["https://letterboxd.com/studio/a24/"], pages: 4, note: "is an A24 film" },
  "Independent film studio": { urls: ["https://letterboxd.com/studio/mubi/", "https://letterboxd.com/studio/searchlight-pictures/", "https://letterboxd.com/studio/focus-features/", "https://letterboxd.com/studio/annapurna-pictures/", "https://letterboxd.com/studio/ifc-films/", "https://letterboxd.com/studio/sony-pictures-classics/"], pages: 2, note: "comes from an independent film studio" }
};
async function sourceSlugs(k) {
  const s = MOOD_SOURCES[k];
  const parts = await Promise.all(s.urls.map(u => pagedSlugs(u, s.pages).catch(() => [])));
  return [...new Set([...parts.flat(), ...(s.extra || [])])];
}

async function loadTop500() {
  if (window.__top500) return window.__top500;
  window.__top500 = (async () => {
    const base = "https://letterboxd.com/official/list/letterboxds-top-500-films/";
    const map = {};
    const pages = await pmap([1, 2, 3, 4, 5], p => getText(p === 1 ? base : base + "page/" + p + "/"), 3);
    pages.forEach((t, pi) => {
      if (!t) return;
      let idx = 0;
      parseDoc(t).querySelectorAll("[data-item-slug],[data-film-slug]").forEach(e => {
        const s = e.dataset.itemSlug || e.dataset.filmSlug;
        if (s && !(s in map)) map[s] = pi * 100 + (++idx);
      });
    });
    window.__top500Map = map;
    return map;
  })();
  return window.__top500;
}
function decorateCrowns() {
  const map = window.__top500Map;
  if (!map) return;
  document.querySelectorAll(".rec").forEach(li => {
    const rank = map[li.dataset.slug];
    if (!rank || li.querySelector(".crown")) return;
    let wr = li.querySelector(".ratewrap");
    if (!wr) { wr = document.createElement("div"); wr.className = "ratewrap"; li.append(wr); }
    const cr = document.createElement("span"); cr.className = "crown"; cr.title = "Letterboxd\u2019s Top 500 Films, rank " + rank;
    cr.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M2.5 19h19l1.2-11.5-5.2 4.2L12 4.5 6.5 11.7 1.3 7.5z" fill="#e6c229"/></svg>';
    cr.append(document.createTextNode(String(rank)));
    wr.prepend(cr);
  });
}
loadTop500().then(decorateCrowns).catch(() => {});
