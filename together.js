
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
async function applySim() {
  const q = $("simfilm").value.trim();
  if (!q) return clearSim();
  $("simgo").disabled = true; $("simstatus").className = "status"; $("simstatus").textContent = "Finding films like " + q + "\u2026";
  try {
    const slug = await findSlug(q, null);
    if (!slug) throw new Error("Couldn\u2019t find a film called " + q + ".");
    const list = await similarList(slug);
    const d = await getDetails(slug).catch(() => null);
    sim = { slug: slug, name: d ? d.title : q, set: new Set(list) };
    $("simstatus").textContent = "Showing films similar to " + sim.name + ".";
    rank();
  } catch (e) { $("simstatus").className = "status bad"; $("simstatus").textContent = e.message || "Something went wrong."; }
  $("simgo").disabled = false;
}
function clearSim() { sim = null; $("simfilm").value = ""; $("simstatus").className = "status"; $("simstatus").textContent = ""; rank(); }
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
let ctx = null, ranked = [], shownN = 0;
async function run() {
  const names = [];
  document.querySelectorAll(".puser").forEach(i => { const n = cleanUser(i.value); if (n && !names.some(x => x.toLowerCase() === n.toLowerCase())) names.push(n); });
  if (names.length < 2) return status("Add at least two Letterboxd usernames.", true);
  $("find").disabled = true; $("out").hidden = true; sim = null; $("simfilm").value = ""; $("simstatus").textContent = "";
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
function rank() {
  if (!ctx) return;
  const onlyUnseen = $("unseen").checked;
  const entries = sim ? [...sim.set].map(s => [s, ctx.cand.get(s) || { wl: new Set(), sim: new Map() }]) : [...ctx.cand.entries()];
  ranked = entries.filter(e => !onlyUnseen || !ctx.seen.has(e[0])).map(e => {
    const c = e[1]; const users = new Set([...c.wl, ...c.sim.keys()]); let hits = 0; c.sim.forEach(a => { hits += a.length; });
    return { slug: e[0], c: c, users: users, score: users.size * 10 + c.wl.size * 4 + Math.min(hits, 6) + (sim ? 8 : 0) };
  }).sort((a, b) => b.score - a.score).slice(0, 80);
  $("recs").innerHTML = ""; shownN = 0; $("more").hidden = false;
  $("out").hidden = false; $("persWrap").hidden = false;
  status("");
  if (!ranked.length) { status("No matching films found. Try adding more people, removing the similar film, or untick the box.", true); $("more").hidden = true; return; }
  showMore();
}
function reason(r) {
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
  const chip = document.createElement("span"); chip.className = "wl"; chip.textContent = !r.users.size ? "Similar to " + (sim ? sim.name : "your pick") : (r.users.size >= total ? "Matches all " + total + " of you" : "Matches " + r.users.size + " of " + total); h.append(chip);
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
  const batch = ranked.slice(shownN, shownN + 10);
  if (!batch.length) { $("more").hidden = true; return; }
  $("more").disabled = true;
  const det = await pmap(batch, r => getDetails(r.slug), 6);
  batch.forEach((r, k) => { const d = det[k]; if (d) $("recs").append(card(r, d, shownN + k + 1)); });
  shownN += batch.length; $("more").hidden = shownN >= ranked.length; $("more").disabled = false;
}
$("addp").onclick = () => addRow();
$("find").onclick = run;
$("more").onclick = showMore;
$("unseen").onchange = rank;
$("pers").onclick = () => { const p = $("persPanel"); p.hidden = !p.hidden; $("pers").setAttribute("aria-expanded", String(!p.hidden)); $("pers").textContent = p.hidden ? "Personalise your list" : "Hide personalisation"; };
$("simgo").onclick = applySim; $("simx").onclick = clearSim;
$("simfilm").addEventListener("keydown", e => { if (e.key === "Enter") applySim(); });
addRow(); addRow();
