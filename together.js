
const $ = id => document.getElementById(id);
const PROXY = "https://morning-heart-3d02.michalinabukowiecka.workers.dev";
const detailCache = new Map();
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function getText(url) {
  const r = await fetch(PROXY + "/?url=" + encodeURIComponent(url));
  if (!r.ok) throw Object.assign(new Error("http " + r.status), { status: r.status });
  return r.text();
}

const parseDoc = h => new DOMParser().parseFromString(h, "text/html");

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

function cleanUser(v) {
  return v.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, "").split(/[\/?#]/)[0];
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

async function pmap(items, fn, limit = 6) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
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

async function findSlug(name, year) {
  const doc = parseDoc(await getText("https://letterboxd.com/s/search/films/" + encodeURIComponent(name) + "/"));
  const els = [...doc.querySelectorAll("[data-item-slug],[data-film-slug]")];
  const pick = (year && els.find(e => (e.dataset.itemFullDisplayName || "").includes("(" + year + ")"))) || els[0];
  return pick ? (pick.dataset.itemSlug || pick.dataset.filmSlug) : null;
}

function renderStats(people, yr) {
  const names = people.map(p => p.u);
  const w = $("welcome"); w.textContent = "Welcome back, ";
  names.forEach((n, i) => { const u = document.createElement("u"); u.textContent = n; w.append(u); if (i < names.length - 2) w.append(", "); else if (i === names.length - 2) w.append(" and "); });
  w.append(". Here\u2019s what you\u2019ve been watching\u2026");
  const per = new Map();
  people.forEach(p => p.films.forEach(f => { if (!per.has(f.slug)) per.set(f.slug, []); if (f.rating) per.get(f.slug).push(f.rating); }));
  const means = []; per.forEach(a => { if (a.length) means.push(a.reduce((s, x) => s + x, 0) / a.length); });
  const avg = means.length ? means.reduce((s, x) => s + x, 0) / means.length : null;
  let cnt = 0, rated = 0, sum = 0; yr.forEach(y => { cnt += y.count; rated += y.rated; sum += (y.avg || 0) * y.rated; });
  const year = new Date().getFullYear();
  const items = [[per.size.toLocaleString("en-US"), "Films logged"], [avg ? avg.toFixed(2) + "\u2605" : "\u2013", "Average rating, all logged films"], [cnt.toLocaleString("en-US"), "Watched in " + year], [rated ? (sum / rated).toFixed(2) + "\u2605" : "\u2013", "Average rating in " + year]];
  const st = $("stats"); st.innerHTML = "";
  items.forEach(it => { const d = document.createElement("div"); d.className = "stat"; const b = document.createElement("b"); b.textContent = it[0]; const s = document.createElement("span"); s.textContent = it[1]; d.append(b, s); st.append(d); });
  $("statsPanel").hidden = false;
}
let sim = null;
function status(t, bad) { const s = $("status"); s.textContent = t || ""; s.className = "status" + (bad ? " bad" : ""); }
function joinNames(a) { if (a.length <= 1) return a.join(""); return a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
function shuffle(a) { return a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(x => x[1]); }
function syncDel() { const rows = document.querySelectorAll(".prow"); rows.forEach(r => { r.querySelector(".pdel").hidden = rows.length <= 2; }); }
function addRow() {
  const row = document.createElement("div"); row.className = "row prow";
  const inp = document.createElement("input"); inp.type = "text"; inp.className = "puser"; inp.placeholder = "Letterboxd username"; inp.autocomplete = "off"; inp.spellcheck = false;
  const del = document.createElement("button"); del.type = "button"; del.className = "ghost pdel"; del.textContent = "\u2715"; del.setAttribute("aria-label", "Remove person");
  del.onclick = () => { row.remove(); syncDel(); };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
  row.append(inp, del); $("people").append(row); syncDel();
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
  "A24": () => true,
  "Independent film studio": () => true,
  "Weird and unexpected": m => G(m, "Fantasy", "Science Fiction", "Horror", "Mystery") && m.count < 250000,
  "3.5★+": m => m.rating >= 3.5,
  "4★+": m => m.rating >= 4,
  "Surprise me": () => true,
};
const MOOD_SOURCES = {
  "1001 Movies You Must See Before You Die": { urls: ["https://letterboxd.com/gubarenko/list/1001-movies-you-must-see-before-you-die-2021/"], pages: 3, note: "is on the 1001 Movies You Must See Before You Die list" },
  "The Ultimate Film Studies": { urls: ["https://letterboxd.com/ganyyy/list/the-ultimate-film-studies-watchlist-expanded/"], pages: 2, note: "is on the Ultimate Film Studies watchlist" },
  "Beautiful cinematography": { urls: ["https://letterboxd.com/oscars/list/oscar-winning-films-cinematography/"], extra: CINE_EXTRA, pages: 2, note: "is celebrated for its cinematography" },
  "Award winning": { urls: ["https://letterboxd.com/oscars/list/oscar-winning-films-best-picture/", "https://letterboxd.com/darrencb/list/palme-dor-winners-ranked-1/"], pages: 2, note: "won a Best Picture Oscar or the Palme d\u2019Or" },
  "Letterboxd's Top 500 Films": { urls: ["https://letterboxd.com/official/list/letterboxds-top-500-films/"], pages: 3, note: "is in Letterboxd\u2019s Top 500 Films" },
  "Horror": { urls: ["https://letterboxd.com/browsehorror/list/horror-movies-everyone-should-watch-at-least/"], pages: 3, note: "is on a list of horror films everyone should watch" },
  "What is reality?": { urls: ["https://letterboxd.com/tediously_brief/list/what-is-reality/", "https://letterboxd.com/magrosleau/list/psychosexual-dramas-nihilistic-fever-dreams/", "https://letterboxd.com/andredenervaux/list/youre-not-the-same-person-once-the-film-has/"], pages: 3, note: "is on a list of films that blur reality and identity" },
  "Good Films, 90 Minutes or Less": { urls: ["https://letterboxd.com/stautis/list/good-films-90-minutes-or-less/"], pages: 3, note: "is a good film that runs 90 minutes or less" },
  "Feeling lost in your 20\u2019s": { urls: ["https://letterboxd.com/adaydreaming/list/feeling-lost-in-your-20s/", "https://letterboxd.com/moviemaestro/list/teenage-wasteland-a-comprehensive-list-of/"], pages: 3, note: "is on a list of films about feeling lost and coming of age" },
  "Chick flicks": { urls: ["https://letterboxd.com/marialuisacctc/list/women-have-superior-taste-that-is-why-these/"], pages: 3, note: "is on a chick-flick list" },
  "Hopeless cinema": { urls: ["https://letterboxd.com/darrencb/list/the-world-is-hell-hopeless-cinema/"], pages: 3, note: "is on a list of hopeless cinema" },
  "Documentary": { urls: ["https://letterboxd.com/official/list/top-250-documentary-films/"], pages: 3, note: "is in Letterboxd\u2019s top documentary films" },
  "A24": { urls: ["https://letterboxd.com/studio/a24/"], pages: 4, note: "is an A24 film" },
  "Independent film studio": { urls: ["https://letterboxd.com/studio/mubi/", "https://letterboxd.com/studio/searchlight-pictures/", "https://letterboxd.com/studio/focus-features/", "https://letterboxd.com/studio/annapurna-pictures/", "https://letterboxd.com/studio/ifc-films/", "https://letterboxd.com/studio/sony-pictures-classics/"], pages: 2, note: "comes from an independent film studio" }
};
const DIRECTORS = { hitchcock: "alfred-hitchcock", kubrick: "stanley-kubrick", tarantino: "quentin-tarantino", nolan: "christopher-nolan", scorsese: "martin-scorsese", lynch: "david-lynch", kurosawa: "akira-kurosawa", bergman: "ingmar-bergman", fellini: "federico-fellini", godard: "jean-luc-godard", truffaut: "francois-truffaut", tarkovsky: "andrei-tarkovsky", "wes anderson": "wes-anderson", coppola: "francis-ford-coppola", spielberg: "steven-spielberg", villeneuve: "denis-villeneuve", fincher: "david-fincher", polanski: "roman-polanski", "wong kar-wai": "wong-kar-wai", "bong joon-ho": "bong-joon-ho", "park chan-wook": "park-chan-wook", almodovar: "pedro-almodovar", haneke: "michael-haneke", "von trier": "lars-von-trier", cronenberg: "david-cronenberg", kieslowski: "krzysztof-kieslowski", varda: "agnes-varda", ozu: "yasujiro-ozu", miyazaki: "hayao-miyazaki", herzog: "werner-herzog", wenders: "wim-wenders", welles: "orson-welles", chaplin: "charlie-chaplin", eisenstein: "sergei-m-eisenstein", godzilla: "ishiro-honda" };
async function listFrom(url) {
  const doc = parseDoc(await getText(url));
  const out = [], seen = new Set();
  doc.querySelectorAll("[data-item-slug],[data-film-slug]").forEach(el => {
    const s = el.dataset.itemSlug || el.dataset.filmSlug;
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  });
  return out;
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
async function sourceSlugs(k) {
  const s = MOOD_SOURCES[k];
  const parts = await Promise.all(s.urls.map(u => pagedSlugs(u, s.pages).catch(() => [])));
  return [...new Set([...parts.flat(), ...(s.extra || [])])];
}
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
let ctx = null, ranked = [], shownN = 0;
async function run() {
  const names = [];
  document.querySelectorAll(".puser").forEach(i => { const n = cleanUser(i.value); if (n && !names.some(x => x.toLowerCase() === n.toLowerCase())) names.push(n); });
  if (names.length < 2) return status("Add at least two Letterboxd usernames.", true);
  $("find").disabled = true; $("out").hidden = true; sim = null; curF = null; resetPers();
  try {
    const people = [];
    for (const u of names) {
      status("Reading " + u + "\u2019s films\u2026");
      let films;
      try { films = await fetchAllPages(u + "/films", 80, n => status("Reading " + u + "\u2019s films\u2026 " + n + " so far")); }
      catch (e) { throw new Error("Couldn\u2019t read " + u + "\u2019s Letterboxd. Check the username and that the profile is public."); }
      if (!films.length) throw new Error(u + " has no public films on Letterboxd.");
      let wl = [];
      status("Reading " + u + "\u2019s watchlist\u2026");
      try { wl = await fetchAllPages(u + "/watchlist", 15, function () {}); } catch (e) {}
      people.push({ u: u, films: films, wl: wl });
    }
    status("Adding up everyone\u2019s stats\u2026");
    const yr = await Promise.all(people.map(p => fetchYear(p.u).catch(() => ({ year: new Date().getFullYear(), count: 0, rated: 0, avg: null }))));
    renderStats(people, yr);
    const cand = new Map();
    const get = s => { let c = cand.get(s); if (!c) { c = { wl: new Set(), sim: new Map() }; cand.set(s, c); } return c; };
    const seen = new Map();
    people.forEach(p => { p.films.forEach(f => { if (!seen.has(f.slug)) seen.set(f.slug, []); seen.get(f.slug).push(p.u); }); p.wl.forEach(f => get(f.slug).wl.add(p.u)); });
    const jobs = [];
    people.forEach(p => {
      let favs = p.films.filter(f => f.rating >= 4).sort((a, b) => b.rating - a.rating);
      if (!favs.length) favs = p.films.slice(0, 20);
      shuffle(favs.slice(0, 40)).slice(0, 8).forEach(f => jobs.push({ p: p, f: f }));
    });
    status("Finding films like everyone\u2019s favourites\u2026");
    await pmap(jobs, async j => {
      const list = await similarList(j.f.slug);
      list.forEach(s => { const c = get(s); if (!c.sim.has(j.p.u)) c.sim.set(j.p.u, []); c.sim.get(j.p.u).push(j.f.name); });
    }, 6);
    ctx = { people: people, cand: cand, seen: seen };
    status("");
    rank();
  } catch (e) { status(e.message || "Something went wrong.", true); }
  $("find").disabled = false;
}

let curF = null, rid = 0, pos = 0, rfMin = 0;
function rank() { return updateList(); }
function resetPers() {
  ["extra", "similar", "director"].forEach(function (x) { var e = $(x); if (e) e.value = ""; });
  ["len", "decade"].forEach(function (x) { var e = $(x); if (e) { var i = [].findIndex.call(e.options, function (o) { return o.defaultSelected; }); e.selectedIndex = i < 0 ? 0 : i; } });
  document.querySelectorAll("#moods .mood, #moods2 .mood").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
  if ($("pstatus")) { $("pstatus").textContent = ""; $("pstatus").className = "status"; }
}
function readPers() {
  var pressed = function (sel) { return [].map.call(document.querySelectorAll(sel + ' .mood[aria-pressed="true"]'), function (b) { return b.dataset.p; }); };
  return { desc: ($("extra").value || "").trim(), sim: ($("similar").value || "").trim(), dir: ($("director").value || "").trim(), len: +$("len").value || 0, dec: +$("decade").value || 0, moods: pressed("#moods"), lmoods: pressed("#moods2") };
}
function buildFilter(P) {
  var f = { len: P.len, dec: P.dec, minRt: 0, preds: [], dg: [], dd: [] };
  P.moods.forEach(function (k) {
    var m = /^(\d(?:\.\d)?)\u2605\+$/.exec(k);
    if (m) f.minRt = Math.max(f.minRt, +m[1]);
    else if (!MOOD_SOURCES[k] && MOODS[k]) f.preds.push(MOODS[k]);
  });
  var D = P.desc.toLowerCase();
  [["horror", "Horror"], ["comed", "Comedy"], ["sci-?fi|science fiction", "Science Fiction"], ["thriller", "Thriller"], ["romance|romantic", "Romance"], ["\\bwar\\b", "War"], ["animat", "Animation"], ["documentar", "Documentary"], ["western", "Western"], ["crime", "Crime"], ["fantasy", "Fantasy"], ["mystery", "Mystery"], ["musical", "Music"]].forEach(function (p) { if (new RegExp(p[0]).test(D)) f.dg.push(p[1]); });
  var re = /\b(?:19|20)?(\d)0'?s\b/g, mm;
  while ((mm = re.exec(D))) { var dg = +mm[1]; f.dd.push(dg >= 3 ? 1900 + dg * 10 : 2000 + dg * 10); }
  return f;
}
function passes(d) {
  var f = curF; if (!f) return true;
  var g = d.genres || (d.genres = []);
  if (f.len && d.runtime && d.runtime > f.len) return false;
  if (f.dec && !(d.year && (f.dec < 0 ? d.year < 1920 : d.year >= f.dec && d.year < f.dec + 10))) return false;
  if (f.minRt && !(d.rating >= f.minRt)) return false;
  if (f.preds.length && !f.preds.some(function (p) { try { return p(d); } catch (e) { return false; } })) return false;
  if (f.dg.length && !f.dg.some(function (x) { return g.indexOf(x) >= 0; })) return false;
  if (f.dd.length && !f.dd.some(function (y) { return d.year >= y && d.year < y + 10; })) return false;
  return true;
}
function reason(r) {
  var t = reason0(r); if (t !== ".") return t;
  return "It " + (r.note || "fits the filters you picked") + ".";
}
async function updateList() {
  if (!ctx) return;
  var my = ++rid, P = readPers(), ps = $("pstatus"), upd = $("upd");
  function pst(t, bad) { ps.className = bad ? "status bad" : "status"; ps.textContent = t || ""; }
  upd.disabled = true; pst("Updating\u2026");
  try {
    var sets = [], notes = new Map(); sim = null;
    if (P.sim) {
      var slug = await findSlug(P.sim, null);
      if (!slug) throw new Error("Couldn\u2019t find a film called " + P.sim + ".");
      var list = await similarList(slug);
      var d0 = await getDetails(slug).catch(function () { return null; });
      sim = { slug: slug, name: d0 ? d0.title : P.sim, set: new Set(list) };
      sets.push(sim.set);
    }
    if (P.dir) {
      var dl = await directorFilms(P.dir).catch(function () { return null; });
      if (!dl || !dl.slugs.length) throw new Error("Couldn\u2019t find a director called " + P.dir + ".");
      var ds = new Set(dl.slugs); ds.forEach(function (s) { notes.set(s, "is a film by " + dl.name); }); sets.push(ds);
    }
    var keys = P.lmoods.concat(P.moods.filter(function (k) { return MOOD_SOURCES[k]; }));
    if (keys.length) {
      pst("Reading your Letterboxd lists\u2026");
      var got = await Promise.all(keys.map(function (k) { return sourceSlugs(k).then(function (a) { return { k: k, a: a }; }).catch(function () { return { k: k, a: [] }; }); }));
      var u = new Set();
      got.forEach(function (x) { x.a.forEach(function (s) { u.add(s); if (!notes.has(s)) notes.set(s, (MOOD_SOURCES[x.k] || {}).note || ""); }); });
      if (!u.size) throw new Error("Couldn\u2019t read those lists right now.");
      sets.push(u);
    }
    if (my !== rid) return;
    curF = (P.desc || P.len || P.dec || P.moods.length) ? buildFilter(P) : null;
    var onlyUnseen = $("unseen").checked;
    var slugs = sets.length ? [...sets[0]].filter(function (s) { return sets.every(function (x) { return x.has(s); }); }) : [...ctx.cand.keys()];
    ranked = slugs.filter(function (s) { return !onlyUnseen || !ctx.seen.has(s); }).map(function (s) {
      var c = ctx.cand.get(s) || { wl: new Set(), sim: new Map() };
      var users = new Set([...c.wl, ...c.sim.keys()]); var hits = 0; c.sim.forEach(function (a) { hits += a.length; });
      return { slug: s, c: c, users: users, note: notes.get(s) || "", score: users.size * 10 + c.wl.size * 4 + Math.min(hits, 6) + (sim ? 8 : 0) + Math.random() };
    }).sort(function (a, b) { return b.score - a.score; }).slice(0, 250);
    pos = 0; shownN = 0;
    $("recs").innerHTML = ""; $("out").hidden = false; $("persWrap").hidden = false; $("recNone").hidden = true; $("more").hidden = true; status("");
    pst(sim ? "Showing films similar to " + sim.name + "." : "");
    if (!ranked.length) { status("No matching films found. Try loosening your choices or untick the box.", true); return; }
    await showMore();
  } catch (e) { pst(e.message || "Something went wrong.", true); }
  finally { upd.disabled = false; }
}
function applyRf() {
  var vis = 0;
  document.querySelectorAll("#recs > li").forEach(function (li) { var ok = !rfMin || +li.dataset.rt >= rfMin; li.hidden = !ok; if (ok) vis++; });
  $("recNone").hidden = vis > 0 || !shownN;
  return vis;
}

function reason0(r) {
  const parts = []; const wl = [...r.c.wl];
  if (wl.length) parts.push(wl.length === 1 ? "it\u2019s on " + wl[0] + "\u2019s watchlist" : "it\u2019s on the watchlists of " + joinNames(wl));
  const sims = [];
  r.c.sim.forEach((arr, u) => { const uniq = [...new Set(arr)].slice(0, 2); sims.push(u + "\u2019s favourite" + (uniq.length > 1 ? "s " : " ") + joinNames(uniq)); });
  if (sims.length) parts.push("it\u2019s similar to " + joinNames(sims));
  if (sim && sim.set.has(r.slug)) parts.push("it\u2019s similar to " + sim.name + ", which you picked");
  const t = parts.join(", and ");
  return t.charAt(0).toUpperCase() + t.slice(1) + ".";
}
function card(r, d, n) {
  const total = ctx.people.length;
  const li = document.createElement("li"); li.className = "rec";
  li.innerHTML = '<div class="rank"></div><img class="rp" alt=""><div><h3></h3><div class="meta"></div><p class="desc"></p><p class="why"></p><p class="fit"></p><a target="_blank" rel="noopener">Open on Letterboxd \u2197</a></div>';
  li.querySelector(".rank").textContent = n;
  const im = li.querySelector(".rp"); if (d.poster) { im.src = d.poster; im.referrerPolicy = "no-referrer"; } else im.remove();
  const h = li.querySelector("h3"); h.textContent = d.title; const sm = document.createElement("small"); sm.textContent = d.year || ""; h.append(sm);
  const chip = document.createElement("span"); chip.className = "wl"; chip.textContent = !r.users.size ? (sim ? "Similar to " + sim.name : "From your filters") : (r.users.size >= total ? "Matches all " + total + " of you" : "Matches " + r.users.size + " of " + total); h.append(chip);
  li.querySelector(".meta").textContent = [d.director, d.runtime && d.runtime + " min"].filter(Boolean).join(" \u00b7 ");
  li.querySelector(".desc").textContent = d.desc || "";
  li.querySelector(".why").textContent = (d.genres || []).slice(0, 3).join(", ");
  const fit = li.querySelector(".fit"); const b = document.createElement("strong"); b.textContent = "Why you might all like it: "; fit.append(b, document.createTextNode(reason(r)));
  const sb = ctx.seen.get(r.slug); if (sb && sb.length) fit.append(document.createTextNode(" Already seen by " + joinNames(sb) + "."));
  li.querySelector("a").href = "https://letterboxd.com/film/" + r.slug + "/";
  if (d.rating) { const bd = document.createElement("div"); bd.className = "ratebadge"; bd.title = "Letterboxd members\u2019 average rating"; bd.textContent = Number(d.rating).toFixed(1) + " \u2605"; const wr = document.createElement("div"); wr.className = "ratewrap"; wr.append(bd); li.append(wr); }
  return li;
}

async function showMore() {
  var my = rid; $("more").disabled = true; var added = 0;
  while (added < 10 && pos < ranked.length && my === rid) {
    var chunk = ranked.slice(pos, pos + 10); pos += chunk.length;
    var det = await pmap(chunk, function (r) { return getDetails(r.slug).catch(function () { return null; }); }, 6);
    if (my !== rid) return;
    chunk.forEach(function (r, k) {
      var d = det[k];
      if (d && passes(d)) { shownN++; var li = card(r, d, shownN); li.dataset.rt = d.rating || 0; $("recs").append(li); added++; }
    });
  }
  applyRf();
  var left = ranked.length - pos;
  $("more").hidden = left <= 0; $("more").disabled = false; $("more").textContent = "Show " + Math.min(10, left) + " more";
  if (!shownN && left <= 0) status("No films matched those choices. Try loosening them, or untick the box.", true); else status("");
}
$("addp").onclick = function () { addRow(); };
$("find").onclick = run;
$("more").onclick = showMore;
$("unseen").onchange = updateList;
$("upd").onclick = updateList;
$("clear").onclick = function () { rid++; ranked = []; pos = 0; shownN = 0; $("recs").innerHTML = ""; $("out").hidden = true; status(""); };
document.querySelectorAll(".rf").forEach(function (b) {
  b.onclick = async function () {
    document.querySelectorAll(".rf").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    rfMin = +b.dataset.min || 0; var n = 0;
    while (applyRf() < 5 && !$("more").hidden && n++ < 4) await showMore();
  };
});
document.querySelectorAll("#persPanel .mood").forEach(function (b) { b.onclick = function () { b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true"); }; });
["similar", "director"].forEach(function (x) { $(x).addEventListener("keydown", function (e) { if (e.key === "Enter") updateList(); }); });
window.onSecCleared = updateList;
initPers("pers", "persPanel");
addRow(); addRow();


function initPers(btnId, boxId) {
  var btn = document.getElementById(btnId), box = document.getElementById(boxId);
  if (!btn || !box) return;
  var SEC = ["secDesc", "secFilt", "secLists"];
  var gg = function (id) { return document.getElementById(id); };
  var resetEl = function (el) { if (!el) return; if (el.tagName === "SELECT") { var i = [].findIndex.call(el.options, function (o) { return o.defaultSelected; }); el.selectedIndex = i < 0 ? 0 : i; } else el.value = ""; };
  var unpress = function (sel) { document.querySelectorAll(sel).forEach(function (b) { b.setAttribute("aria-pressed", "false"); }); };
  function clearSec(id) {
    if (id === "secDesc") resetEl(gg("extra"));
    if (id === "secFilt") { ["similar", "len", "director", "decade"].forEach(function (x) { resetEl(gg(x)); }); unpress("#moods .mood"); }
    if (id === "secLists") unpress("#moods2 .mood");
  }
  function show(id, on) { gg(id).hidden = !on; var b = box.querySelector('.incbtn[data-sec="' + id + '"]'); if (b) b.hidden = on; }
  box.querySelectorAll(".incbtn").forEach(function (b) { b.onclick = function () { show(b.dataset.sec, true); }; });
  box.querySelectorAll(".secx").forEach(function (b) { b.onclick = function () { clearSec(b.dataset.sec); show(b.dataset.sec, false); if (window.onSecCleared) window.onSecCleared(); }; });
  btn.onclick = function () {
    var open = box.hidden; box.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Hide personalisation" : "Personalise your recommendation list";
    if (!open) { SEC.forEach(function (id) { clearSec(id); show(id, false); }); if (window.onSecCleared) window.onSecCleared(); }
  };
}
