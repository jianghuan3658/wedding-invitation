/** Fixed, credential-free relay for this wedding's Supabase project. */
export const UPSTREAM = "https://xnqgblzvcltiomqfecsn.supabase.co";
export const SERVICE_HEALTH_PATH = "/rest/v1/rpc/wedding_service_health";
export const ALLOWED_ORIGINS = new Set([
  "https://jianghuan3658.github.io",
  // Remove this origin after local acceptance testing.
  "http://localhost:8768",
]);

const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_FRAME = 64 * 1024;
const MAX_BUFFER = 256 * 1024;
const MAX_CONNECTIONS = 64;
const HTTP_TIMEOUT = 10_000;
const WS_CONNECT_TIMEOUT = 10_000;
const WS_IDLE_TIMEOUT = 75_000;
const WS_MAX_LIFETIME = 60 * 60 * 1000;
const encoder = new TextEncoder();
const FORWARD_HEADERS = new Set([
  "apikey",
  "authorization",
  "content-type",
  "accept",
  "x-client-info",
  "x-supabase-api-version",
  "accept-profile",
  "content-profile",
  "prefer",
]);
const ROUTES = new Map([
  ["/auth/v1/signup", "POST"],
  ["/auth/v1/token", "POST"],
  ["/auth/v1/user", "GET"],
  ["/auth/v1/logout", "POST"],
  ["/rest/v1/rpc/submit_wedding_rsvp", "POST"],
  ["/rest/v1/rpc/authorize_wedding_admin", "POST"],
  ["/rest/v1/rpc/list_wedding_rsvps", "POST"],
  [SERVICE_HEALTH_PATH, "POST"],
  ["/rest/v1/wedding_rsvps", "GET"],
  ["/realtime/v1/websocket", "GET"],
]);

type Socket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "addEventListener" | "binaryType">;
type Dependencies = {
  fetch?: typeof fetch;
  connect?: (url: string) => Socket;
  upgrade?: (request: Request) => { socket: Socket; response: Response };
};
type Json = Record<string, unknown>;

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jwtRole(token: string): string | null {
  if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const encoded = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}

// This checks credential *type*, not JWT validity. Supabase verifies signatures and RLS.
function safeCredential(token: string, apiKey = false): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(token) && token.length <= 512) return true;
  const role = jwtRole(token);
  return apiKey ? role === "anon" : role === "anon" || role === "authenticated";
}

function privilegedValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (typeof value === "string") {
    const token = value.replace(/^Bearer\s+/i, "");
    return token.startsWith("sb_secret_") || jwtRole(token) === "service_role";
  }
  if (Array.isArray(value)) return value.some((entry) => privilegedValue(entry, depth + 1));
  if (object(value)) return Object.values(value).some((entry) => privilegedValue(entry, depth + 1));
  return false;
}

function responseHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  });
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set(
      "Access-Control-Expose-Headers",
      "Content-Range, Preference-Applied, Retry-After, X-Supabase-Api-Version, X-Sb-Error-Code",
    );
  }
  return headers;
}

function error(status: number, code: string, origin: string | null): Response {
  const message = status === 502 || status === 504 ? "回执服务暂时无法连接，请稍后重试。" : "此请求未获允许。";
  // Both GoTrue and PostgREST SDKs understand these fields.
  return new Response(JSON.stringify({ code, error_code: code, message }), {
    status,
    headers: responseHeaders(origin),
  });
}

function queryAllowed(url: URL): boolean {
  const query = url.searchParams;
  const keys = [...query.keys()];
  if (new Set(keys).size !== keys.length || url.search.length > 12_000) return false;
  switch (url.pathname) {
    case "/auth/v1/token":
      return keys.length === 1 && keys[0] === "grant_type" &&
        ["password", "refresh_token"].includes(query.get("grant_type")!);
    case "/auth/v1/logout":
      return keys.every((key) => key === "scope") &&
        (!query.has("scope") || ["local", "global", "others"].includes(query.get("scope")!));
    case "/rest/v1/wedding_rsvps": {
      const fields = new Set(["id", "name", "people", "created_at", "submitted_at"]);
      if (!keys.every((key) => ["select", "order", "limit", "offset"].includes(key))) return false;
      if (query.has("select") && !query.get("select")!.split(",").every((field) => fields.has(field))) return false;
      if (
        query.has("order") &&
        !/^(created_at|submitted_at|id)\.(asc|desc)(,(created_at|submitted_at|id)\.(asc|desc))*$/.test(
          query.get("order")!,
        )
      ) return false;
      if (query.has("limit") && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(query.get("limit")!)) return false;
      if (query.has("offset") && !/^(?:0|[1-9][0-9]{0,5})$/.test(query.get("offset")!)) return false;
      return true;
    }
    case "/realtime/v1/websocket":
      return keys.every((key) => ["apikey", "vsn", "eventsPerSecond"].includes(key)) &&
        safeCredential(query.get("apikey") || "", true) &&
        (!query.has("vsn") || ["1.0.0", "2.0.0"].includes(query.get("vsn")!)) &&
        (!query.has("eventsPerSecond") || /^(?:[1-9]|10)$/.test(query.get("eventsPerSecond")!));
    default:
      return keys.length === 0;
  }
}

function forwardedHeaders(request: Request): Headers | null {
  const result = new Headers();
  for (const [key, value] of request.headers) {
    if (FORWARD_HEADERS.has(key)) result.set(key, value);
  }
  if (!safeCredential(result.get("apikey") || "", true)) return null;
  const authorization = result.get("authorization");
  if (!authorization || !/^Bearer /i.test(authorization) || !safeCredential(authorization.slice(7))) return null;
  for (const header of ["accept-profile", "content-profile"]) {
    if (result.has(header) && result.get(header) !== "public") return null;
  }
  const prefer = result.get("prefer");
  if (
    prefer &&
    !prefer.split(",").every((part) =>
      ["return=representation", "return=minimal", "count=exact", "count=planned", "count=estimated"].includes(
        part.trim(),
      )
    )
  ) return null;
  if ([...result.values()].some((value) => value.length > 8192)) return null;
  return result;
}

export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function validBody(path: string, grant: string | null, payload: unknown): boolean {
  if (!object(payload) || privilegedValue(payload)) return false;
  const keys = Object.keys(payload);
  const only = (allowed: string[]) => keys.every((key) => allowed.includes(key));
  const security = payload.gotrue_meta_security;
  if (
    security !== undefined &&
    (!object(security) || Object.keys(security).some((key) => key !== "captcha_token") ||
      (security.captcha_token !== undefined && typeof security.captcha_token !== "string"))
  ) return false;
  switch (path) {
    case "/auth/v1/signup":
      // The invitation creates anonymous visitors; permanent account creation stays private.
      return only(["data", "gotrue_meta_security"]) && (!payload.data || object(payload.data));
    case "/auth/v1/token":
      return grant === "password"
        ? only(["email", "password", "gotrue_meta_security"]) && typeof payload.email === "string" &&
          typeof payload.password === "string" && payload.email.length <= 320 && payload.password.length <= 1024
        : only(["refresh_token"]) && typeof payload.refresh_token === "string" && payload.refresh_token.length <= 8192;
    case "/auth/v1/logout":
    case "/rest/v1/rpc/authorize_wedding_admin":
    case SERVICE_HEALTH_PATH:
      return keys.length === 0;
    case "/rest/v1/rpc/submit_wedding_rsvp":
      return only(["p_name", "p_people", "p_submission_id", "p_operation_id", "p_client_version"]);
    case "/rest/v1/rpc/list_wedding_rsvps":
      return only(["p_cursor", "p_limit"]);
    default:
      return false;
  }
}

function sanitizedError(bytes: Uint8Array, status: number): string {
  try {
    const original = JSON.parse(new TextDecoder().decode(bytes));
    if (!object(original)) throw new Error();
    const clean: Json = {};
    for (const key of ["code", "error_code", "error", "message", "msg", "error_description"]) {
      const value = original[key];
      if (typeof value === "string" && !privilegedValue(value)) clean[key] = value.slice(0, 256);
    }
    if (!clean.message && !clean.msg && !clean.error_description) clean.message = "回执请求未完成，请稍后重试。";
    if (!clean.code && !clean.error_code) clean.code = "UPSTREAM_ERROR";
    return JSON.stringify(clean);
  } catch {
    return JSON.stringify({ code: "UPSTREAM_ERROR", message: `回执请求未完成（${status}），请稍后重试。` });
  }
}

function frameAllowed(raw: string): boolean {
  try {
    const message = JSON.parse(raw);
    const value = Array.isArray(message) && message.length === 5
      ? { join_ref: message[0], ref: message[1], topic: message[2], event: message[3], payload: message[4] }
      : message;
    if (
      !object(value) || privilegedValue(value) || typeof value.topic !== "string" || value.topic.length > 256 ||
      !object(value.payload)
    ) return false;
    if (value.event === "heartbeat") return value.topic === "phoenix" && Object.keys(value.payload).length === 0;
    if (!value.topic.startsWith("realtime:wedding-rsvp-admin-")) return false;
    if (value.event === "phx_leave") return Object.keys(value.payload).length === 0;
    if (value.event === "access_token") {
      return typeof value.payload.access_token === "string" && safeCredential(value.payload.access_token);
    }
    if (value.event !== "phx_join") return false;
    if (
      value.payload.access_token !== undefined &&
      (typeof value.payload.access_token !== "string" || !safeCredential(value.payload.access_token))
    ) return false;
    const config = value.payload.config;
    if (!object(config) || !Array.isArray(config.postgres_changes) || config.postgres_changes.length !== 1) {
      return false;
    }
    const subscription = config.postgres_changes[0];
    // Only wedding Postgres notifications are needed; no broadcast/presence writes.
    return object(subscription) && subscription.schema === "public" && subscription.table === "wedding_rsvps" &&
      subscription.event === "*" &&
      Object.keys(subscription).every((key) => ["schema", "table", "event"].includes(key)) &&
      (!object(config.presence) || config.presence.enabled !== true);
  } catch {
    return false;
  }
}

/** Dependency injection is for offline tests; callers cannot select another upstream. */
export function createHandler(dependencies: Dependencies = {}): (request: Request) => Promise<Response> {
  const fetchUpstream = dependencies.fetch || fetch;
  const connect = dependencies.connect || ((url) => new WebSocket(url));
  const upgrade = dependencies.upgrade || ((request) => Deno.upgradeWebSocket(request, { idleTimeout: 75 }));
  let activeConnections = 0;

  function relayWebSocket(request: Request, url: URL, origin: string): Response {
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" || request.headers.has("sec-websocket-protocol")
    ) return error(400, "INVALID_WEBSOCKET", origin);
    if (activeConnections >= MAX_CONNECTIONS) return error(503, "CONNECTION_LIMIT", origin);
    const target = new URL(url.pathname + url.search, UPSTREAM);
    target.protocol = "wss:";
    let downstream: Socket;
    let upstream: Socket | undefined;
    let response: Response;
    try {
      upstream = connect(target.href);
      const upgraded = upgrade(request);
      downstream = upgraded.socket;
      response = upgraded.response;
    } catch {
      try {
        upstream?.close(1000, "Handshake failed");
      } catch { /* no request logs */ }
      return error(502, "PROXY_UNAVAILABLE", origin);
    }
    activeConnections++;
    downstream.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
    let ended = false;
    let pendingBytes = 0;
    const pending: string[] = [];
    // Web API close() accepts 1000 or application codes 3000..4999, not 1001..1013.
    const close = (code = 4001, reason = "Relay closed") => {
      if (ended) return;
      ended = true;
      activeConnections--;
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      clearTimeout(lifetimeTimer);
      pending.length = 0;
      pendingBytes = 0;
      for (const socket of [downstream, upstream]) {
        try {
          if (socket.readyState < 2) socket.close(code, reason);
        } catch { /* no credential-bearing error logs */ }
      }
    };
    let idleTimer = setTimeout(() => close(4001, "Idle timeout"), WS_IDLE_TIMEOUT);
    const connectTimer = setTimeout(() => close(4011, "Upstream unavailable"), WS_CONNECT_TIMEOUT);
    const lifetimeTimer = setTimeout(() => close(4001, "Reconnect required"), WS_MAX_LIFETIME);
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => close(4001, "Idle timeout"), WS_IDLE_TIMEOUT);
    };
    const send = (socket: Socket, data: string | ArrayBuffer) => {
      if (ended) return;
      if (socket.readyState !== 1 || socket.bufferedAmount > MAX_BUFFER) {
        close(4013, "Backpressure");
        return;
      }
      try {
        socket.send(data);
      } catch {
        close(4011, "Transport error");
      }
    };
    upstream.addEventListener("open", () => {
      clearTimeout(connectTimer);
      if (ended) return;
      for (const raw of pending) send(upstream, raw);
      pending.length = 0;
      pendingBytes = 0;
    });
    downstream.addEventListener(
      "message",
      ((event: MessageEvent) => {
        if (ended) return;
        const raw = event.data;
        // Supabase Postgres changes and heartbeats are text in both protocol versions.
        if (typeof raw !== "string") {
          close(4003, "Text protocol required");
          return;
        }
        const size = encoder.encode(raw).length;
        if (size > MAX_FRAME || !frameAllowed(raw)) {
          close(4008, "Message not allowed");
          return;
        }
        touch();
        if (upstream.readyState === 0) {
          if (pending.length >= 16 || pendingBytes + size > MAX_BUFFER) {
            close(4013, "Queue limit");
            return;
          }
          pending.push(raw);
          pendingBytes += size;
        } else send(upstream, raw);
      }) as EventListener,
    );
    upstream.addEventListener(
      "message",
      ((event: MessageEvent) => {
        if (ended) return;
        const data = event.data;
        const size = typeof data === "string"
          ? encoder.encode(data).length
          : data instanceof ArrayBuffer
          ? data.byteLength
          : Infinity;
        if (size > MAX_FRAME) {
          close(4009, "Message too large");
          return;
        }
        touch();
        send(downstream, data);
      }) as EventListener,
    );
    for (const socket of [downstream, upstream]) {
      socket.addEventListener("close", () => close());
      socket.addEventListener("error", (event) => {
        event.preventDefault();
        close(4011, "Transport error");
      });
    }
    return response;
  }

  return async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (url.pathname === "/health" && request.method === "GET" && !url.search) {
      return new Response('{"ok":true}', { headers: responseHeaders(origin) });
    }
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return error(403, "ORIGIN_NOT_ALLOWED", origin);
    if (privilegedValue(request.headers.get("apikey")) || privilegedValue(request.headers.get("authorization"))) {
      return error(403, "CREDENTIAL_NOT_ALLOWED", origin);
    }
    const method = ROUTES.get(url.pathname);
    if (!method || !queryAllowed(url)) return error(404, "ROUTE_NOT_ALLOWED", origin);
    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("access-control-request-method");
      const requestedHeaders = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",")
        .map((value) => value.trim()).filter(Boolean);
      if (requestedMethod !== method || requestedHeaders.some((header) => !FORWARD_HEADERS.has(header))) {
        return error(403, "PREFLIGHT_NOT_ALLOWED", origin);
      }
      const headers = responseHeaders(origin);
      headers.set("Access-Control-Allow-Methods", method);
      headers.set("Access-Control-Allow-Headers", [...FORWARD_HEADERS].join(", "));
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== method) return error(405, "METHOD_NOT_ALLOWED", origin);
    if (url.pathname === "/realtime/v1/websocket") return relayWebSocket(request, url, origin);
    const headers = forwardedHeaders(request);
    if (!headers) return error(403, "CREDENTIAL_NOT_ALLOWED", origin);
    let body: Uint8Array | undefined;
    if (method === "POST") {
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") || "")) {
        return error(415, "JSON_REQUIRED", origin);
      }
      try {
        body = await readBounded(request.body, MAX_BODY);
        const payload = body.length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) : {};
        if (!validBody(url.pathname, url.searchParams.get("grant_type"), payload)) {
          return error(400, "BODY_NOT_ALLOWED", origin);
        }
        if (!body.length) body = encoder.encode("{}");
      } catch {
        return error(400, "INVALID_BODY", origin);
      }
    }
    // A plain select has a safe field selection and bounded page even if omitted by the SDK.
    const target = new URL(url.pathname + url.search, UPSTREAM);
    if (url.pathname === "/rest/v1/wedding_rsvps") {
      if (!target.searchParams.has("select")) {
        target.searchParams.set("select", "id,name,people,created_at,submitted_at");
      }
      if (!target.searchParams.has("limit")) target.searchParams.set("limit", "100");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
    try {
      const upstream = await fetchUpstream(target.href, {
        method,
        headers,
        body: body as BodyInit | undefined,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) return error(502, "UPSTREAM_REDIRECT", origin);
      const outputHeaders = responseHeaders(origin);
      for (const header of ["content-range", "preference-applied", "x-supabase-api-version", "x-sb-error-code"]) {
        const value = upstream.headers.get(header);
        if (value && value.length <= 256) outputHeaders.set(header, value);
      }
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter && /^\d{1,5}$/.test(retryAfter)) outputHeaders.set("Retry-After", retryAfter);
      if (upstream.status === 204) return new Response(null, { status: 204, headers: outputHeaders });
      const bytes = await readBounded(upstream.body, MAX_RESPONSE);
      if (upstream.status >= 400) {
        return new Response(sanitizedError(bytes, upstream.status), {
          status: upstream.status,
          headers: outputHeaders,
        });
      }
      if (!/^application\/json(?:\s*;.*)?$/i.test(upstream.headers.get("content-type") || "")) {
        return error(502, "INVALID_UPSTREAM_RESPONSE", origin);
      }
      // Successful Auth responses include the user's own session tokens; relay without logging.
      JSON.parse(new TextDecoder().decode(bytes));
      return new Response(bytes, { status: upstream.status, headers: outputHeaders });
    } catch {
      return error(controller.signal.aborted ? 504 : 502, "PROXY_UNAVAILABLE", origin);
    } finally {
      clearTimeout(timeout);
    }
  };
}

const handler = createHandler();
export default { fetch: handler };
if (import.meta.main) Deno.serve(handler);
