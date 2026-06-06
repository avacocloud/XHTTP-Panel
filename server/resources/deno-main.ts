const TARGET_BASE       = (Deno.env.get("TARGET_DOMAIN")     || "").replace(/\/$/, "");
const PUBLIC_RELAY_PATH = normalizeRelayPath(Deno.env.get("PUBLIC_RELAY_PATH") || "/api");
const RELAY_PATH        = normalizeRelayPath(Deno.env.get("RELAY_PATH")        || "/api");
const RELAY_KEY         = (Deno.env.get("RELAY_KEY")         || "").trim();
const UPSTREAM_TIMEOUT_MS = parsePositiveInt(Deno.env.get("UPSTREAM_TIMEOUT_MS"), 0, 1000);
const MAX_INFLIGHT      = parsePositiveInt(Deno.env.get("MAX_INFLIGHT"), 512, 1);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

const FORWARD_HEADER_EXACT = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control",
  "content-length", "content-type", "pragma", "range", "referer", "user-agent",
]);

const FORWARD_HEADER_PREFIXES = ["sec-ch-", "sec-fetch-"];

const STRIP_HEADERS = new Set([
  "host", "connection", "proxy-connection", "keep-alive", "via",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "forwarded", "x-forwarded-host",
  "x-forwarded-proto", "x-forwarded-port", "x-forwarded-for", "x-real-ip",
]);

let inFlight = 0;

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // ── Debug endpoint ──────────────────────────────────────────────────────────
  if (url.pathname === "/__debug") {
    return Response.json({
      TARGET_BASE,
      PUBLIC_RELAY_PATH,
      RELAY_PATH,
      RELAY_KEY_SET: !!RELAY_KEY,
      UPSTREAM_TIMEOUT_MS,
      MAX_INFLIGHT,
      inFlight,
    }, { status: 200 });
  }

  // ── Config checks ───────────────────────────────────────────────────────────
  if (!TARGET_BASE)            return text(500, "Misconfigured: TARGET_DOMAIN is not set");
  if (!RELAY_PATH)             return text(500, "Misconfigured: RELAY_PATH is not set");
  if (RELAY_PATH === "/")      return text(500, "Misconfigured: RELAY_PATH cannot be '/'");
  if (!PUBLIC_RELAY_PATH)      return text(500, "Misconfigured: PUBLIC_RELAY_PATH is not set");
  if (PUBLIC_RELAY_PATH === "/") return text(500, "Misconfigured: PUBLIC_RELAY_PATH cannot be '/'");
  if (RELAY_KEY && RELAY_KEY.length < 16) return text(500, "Misconfigured: RELAY_KEY is too short");

  // ── Routing ─────────────────────────────────────────────────────────────────
  const normalizedPath = normalizeIncomingPath(url.pathname);
  if (!isAllowedRelayPath(normalizedPath, PUBLIC_RELAY_PATH))
    return text(404, "Not Found");

  if (!ALLOWED_METHODS.has(req.method))
    return text(405, "Method Not Allowed", { allow: "GET, HEAD, POST" });

  // ── Auth ────────────────────────────────────────────────────────────────────
  if (RELAY_KEY) {
    const token = req.headers.get("x-relay-key") || "";
    if (token !== RELAY_KEY) return text(403, "Forbidden");
  }

  // ── Inflight limit ──────────────────────────────────────────────────────────
  if (inFlight >= MAX_INFLIGHT) {
    return text(503, "Server Busy: Too Many Inflight Requests", { "retry-after": "1" });
  }
  inFlight++;

  try {
    const upstreamPath = mapPublicPathToRelayPath(normalizedPath, PUBLIC_RELAY_PATH, RELAY_PATH);
    const targetUrl    = `${TARGET_BASE}${upstreamPath}${url.search || ""}`;

    // ── Forward headers ───────────────────────────────────────────────────────
    const forwardHeaders = new Headers();
    for (const [key, value] of req.headers.entries()) {
      const lower = key.toLowerCase();
      if (STRIP_HEADERS.has(lower))    continue;
      if (lower === "x-relay-key")     continue;
      if (!shouldForwardHeader(lower)) continue;
      forwardHeaders.set(key, value);
    }
    const clientIp = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "";
    if (clientIp) forwardHeaders.set("x-forwarded-for", clientIp);

    // ── Fetch upstream ────────────────────────────────────────────────────────
    const hasBody   = req.method !== "GET" && req.method !== "HEAD";
    const abortCtrl = new AbortController();
    let timeoutRef: number | undefined;
    if (UPSTREAM_TIMEOUT_MS > 0) {
      timeoutRef = setTimeout(() => abortCtrl.abort(), UPSTREAM_TIMEOUT_MS);
    }

    try {
      const fetchOpts: RequestInit = {
        method:   req.method,
        headers:  forwardHeaders,
        redirect: "manual",
        signal:   abortCtrl.signal,
      };
      if (hasBody) {
        fetchOpts.body   = req.body;
        // @ts-ignore duplex is required for streaming body
        fetchOpts.duplex = "half";
      }

      const upstream = await fetch(targetUrl, fetchOpts);

      const responseHeaders = new Headers();
      for (const [key, value] of upstream.headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === "transfer-encoding" || lower === "connection") continue;
        try { responseHeaders.set(key, value); } catch { /* skip */ }
      }

      return new Response(upstream.body, {
        status:  upstream.status,
        headers: responseHeaders,
      });

    } finally {
      if (timeoutRef !== undefined) clearTimeout(timeoutRef);
    }

  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return text(504, "Gateway Timeout: Upstream Timeout");
    }
    return text(502, "Bad Gateway: " + String(err));
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function shouldForwardHeader(name: string): boolean {
  if (FORWARD_HEADER_EXACT.has(name)) return true;
  for (const prefix of FORWARD_HEADER_PREFIXES)
    if (name.startsWith(prefix)) return true;
  return false;
}

function isAllowedRelayPath(pathname: string, publicPath: string): boolean {
  return pathname === publicPath || pathname.startsWith(`${publicPath}/`);
}

function mapPublicPathToRelayPath(pathname: string, publicPath: string, relayPath: string): string {
  if (pathname === publicPath) return relayPath;
  return `${relayPath}${pathname.slice(publicPath.length)}`;
}

function normalizeRelayPath(rawPath: string): string {
  if (!rawPath) return "";
  const p = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function normalizeIncomingPath(pathname: string): string {
  if (!pathname) return "/";
  let p = pathname.replace(/\/{2,}/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) return fallback;
  return Math.trunc(v);
}
