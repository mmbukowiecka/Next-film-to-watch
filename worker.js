// Cloudflare Worker: tiny CORS proxy that only fetches letterboxd.com pages.
export default {
  async fetch(req) {
    const cors = { "access-control-allow-origin": "*" };
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...cors, "access-control-allow-methods": "GET", "access-control-allow-headers": "*" } });
    }
    let target;
    try { target = new URL(new URL(req.url).searchParams.get("url")); }
    catch { return new Response("bad url", { status: 400, headers: cors }); }
    const host = target.hostname;
    if (target.protocol !== "https:" || !(host === "letterboxd.com" || host.endsWith(".letterboxd.com"))) {
      return new Response("only letterboxd.com is allowed", { status: 403, headers: cors });
    }
    const r = await fetch(target.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; next-film-to-watch)", "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, "content-type": r.headers.get("content-type") || "text/plain; charset=utf-8" } });
  },
};
