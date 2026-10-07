import { createHandler, UPSTREAM } from "./main.ts";

const origin = "https://jianghuan3658.github.io";
const key = "sb_publishable_mock_public_key";
function jwt(role: string): string {
  return `e30.${
    btoa(JSON.stringify({ role, sub: "11111111-1111-4111-8111-111111111111", is_anonymous: false })).replaceAll("=", "")
  }.signature`;
}
const access = jwt("authenticated");
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}
function request(path: string, options: RequestInit = {}): Request {
  const headers = new Headers({
    origin,
    apikey: key,
    authorization: `Bearer ${access}`,
    "content-type": "application/json",
  });
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  return new Request(`https://wedding-proxy.example${path}`, { ...options, headers });
}
function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}
const submit = "/rest/v1/rpc/submit_wedding_rsvp";

Deno.test("HTTP fixed route, method and Origin allowlist rejects before fetch", async () => {
  let calls = 0;
  const handler = createHandler({
    fetch: (() => {
      calls++;
      return Promise.resolve(json({}));
    }) as typeof fetch,
  });
  for (
    const path of [
      "/",
      "/auth/v1/admin/users",
      "/rest/v1/settings",
      "/rest/v1/rpc/other",
      "/auth/v1/signup?redirect_to=https://evil.example",
      "/rest/v1/rpc/submit_wedding_rsvp?target=https://evil.example",
      "/rest/v1/wedding_rsvps?select=owner_uid",
      "/rest/v1/wedding_rsvps?select=*",
      "/rest/v1/wedding_rsvps?limit=101",
      "/rest/v1/wedding_rsvps?limit=5&limit=6",
    ]
  ) {
    equal((await handler(request(path))).status, 404);
  }
  equal((await handler(request(submit, { method: "PUT", body: "{}" }))).status, 405);
  equal((await handler(request("/rest/v1/wedding_rsvps", { method: "POST", body: "{}" }))).status, 405);
  for (const deniedOrigin of ["https://evil.example", "https://jianghuan3658.github.io.evil.example", "null", ""]) {
    const response = await handler(request(submit, { method: "POST", body: "{}", headers: { origin: deniedOrigin } }));
    equal(response.status, 403);
    equal(response.headers.get("access-control-allow-origin"), null);
  }
  equal(calls, 0);
  equal((await handler(new Request("https://proxy.example/health"))).status, 200);
});

Deno.test("CORS preflight matches exact Origin, method and SDK headers", async () => {
  const handler = createHandler({
    fetch: (() => {
      throw new Error("Must not fetch");
    }) as typeof fetch,
  });
  const response = await handler(request(submit, {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "apikey,authorization,content-type,x-client-info,x-supabase-api-version",
    },
  }));
  equal(response.status, 204);
  equal(response.headers.get("access-control-allow-origin"), origin);
  equal(response.headers.get("access-control-allow-methods"), "POST");
  equal(response.headers.get("cache-control"), "no-store");
  equal(
    (await handler(request(submit, { method: "OPTIONS", headers: { "access-control-request-method": "DELETE" } })))
      .status,
    403,
  );
  equal(
    (await handler(
      request(submit, {
        method: "OPTIONS",
        headers: { "access-control-request-method": "POST", "access-control-request-headers": "cookie" },
      }),
    )).status,
    403,
  );
  equal(
    (await handler(
      request(submit, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:8768", "access-control-request-method": "POST" },
      }),
    )).status,
    204,
  );
});

Deno.test("secret and service_role are denied in headers and request bodies", async () => {
  let calls = 0;
  const handler = createHandler({
    fetch: (() => {
      calls++;
      return Promise.resolve(json({}));
    }) as typeof fetch,
  });
  for (const token of ["sb_secret_mock_private", jwt("service_role"), jwt("postgres"), "malformed"]) {
    equal((await handler(request(submit, { method: "POST", body: "{}", headers: { apikey: token } }))).status, 403);
    equal(
      (await handler(request(submit, { method: "POST", body: "{}", headers: { authorization: `Bearer ${token}` } })))
        .status,
      403,
    );
  }
  for (const token of ["sb_secret_mock_private", jwt("service_role")]) {
    equal(
      (await handler(
        request("/auth/v1/signup", { method: "POST", body: JSON.stringify({ data: { access_token: token } }) }),
      )).status,
      400,
    );
  }
  equal(
    (await handler(request(submit, { method: "POST", body: "{}", headers: { "content-profile": "private" } }))).status,
    403,
  );
  equal(calls, 0);
});

Deno.test("HTTP forwards only allowed headers/body to fixed project and sanitizes error headers", async () => {
  let target = "";
  let init: RequestInit | undefined;
  const handler = createHandler({
    fetch: ((input, options) => {
      target = String(input);
      init = options;
      return Promise.resolve(
        json({ code: "P0001", message: "STALE_OPERATION", details: "private diagnostic", hint: "private hint" }, 400, {
          "set-cookie": "private=value",
          location: "https://evil.example",
          "content-range": "0-99/120",
        }),
      );
    }) as typeof fetch,
  });
  const payload = JSON.stringify({
    p_name: "宾客",
    p_people: 2,
    p_submission_id: "id",
    p_operation_id: "op",
    p_client_version: 1,
  });
  const response = await handler(
    request(submit, {
      method: "POST",
      body: payload,
      headers: { cookie: "user=private", "x-forwarded-host": "evil.example", "x-client-info": "supabase-js-web/mock" },
    }),
  );
  equal(target, UPSTREAM + submit);
  equal(init?.redirect, "error");
  equal(init?.cache, "no-store");
  const forwarded = new Headers(init?.headers);
  equal(forwarded.get("cookie"), null);
  equal(forwarded.get("x-forwarded-host"), null);
  equal(forwarded.get("apikey"), key);
  equal(forwarded.get("authorization"), `Bearer ${access}`);
  equal(new TextDecoder().decode(init?.body as Uint8Array), payload);
  equal(response.status, 400);
  equal(await response.json(), { code: "P0001", message: "STALE_OPERATION" });
  equal(response.headers.get("set-cookie"), null);
  equal(response.headers.get("location"), null);
  equal(response.headers.get("content-range"), "0-99/120");
  equal(response.headers.get("cache-control"), "no-store");
});

Deno.test("anonymous-only signup, JSON/request bounds and controlled admin select", async () => {
  const targets: string[] = [];
  const handler = createHandler({
    fetch: ((input) => {
      targets.push(String(input));
      return Promise.resolve(json({}));
    }) as typeof fetch,
  });
  equal(
    (await handler(
      request("/auth/v1/signup", {
        method: "POST",
        body: '{"data":{},"gotrue_meta_security":{}}',
        headers: { authorization: `Bearer ${key}` },
      }),
    )).status,
    200,
  );
  equal(
    (await handler(
      request("/auth/v1/signup", { method: "POST", body: '{"email":"new@example.com","password":"new"}' }),
    )).status,
    400,
  );
  equal(
    (await handler(request(submit, { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }))).status,
    415,
  );
  equal((await handler(request(submit, { method: "POST", body: "{" }))).status, 400);
  equal(
    (await handler(request(submit, { method: "POST", body: JSON.stringify({ p_name: "a".repeat(65536) }) }))).status,
    400,
  );
  equal((await handler(request("/rest/v1/wedding_rsvps"))).status, 200);
  const table = new URL(targets.at(-1)!);
  equal(table.origin, UPSTREAM);
  equal(table.searchParams.get("limit"), "100");
  equal(table.searchParams.get("select"), "id,name,people,created_at,submitted_at");
  equal(
    (await handler(request("/rest/v1/wedding_rsvps?select=id,name&order=submitted_at.desc&limit=20&offset=100")))
      .status,
    200,
  );
});

Deno.test("network, redirect, non-JSON and oversized upstream responses fail closed", async () => {
  for (
    const source of [
      () => {
        throw new Error("A transport error with sensitive internal information");
      },
      () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
      () => json({ value: "a".repeat(1024 * 1024) }),
    ]
  ) {
    const handler = createHandler({ fetch: (() => Promise.resolve(source())) as typeof fetch });
    const response = await handler(request(submit, { method: "POST", body: "{}" }));
    equal(response.status, 502);
    const payload = await response.text();
    assert(!payload.includes("sensitive"));
    assert(!payload.includes("evil.example"));
  }
  const handler = createHandler({
    fetch: (() =>
      Promise.resolve(new Response("<html>upstream private error</html>", { status: 503 }))) as typeof fetch,
  });
  const response = await handler(request(submit, { method: "POST", body: "{}" }));
  equal(response.status, 503);
  assert(!(await response.text()).includes("private error"));
});

class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  sent: (string | ArrayBuffer)[] = [];
  closed: [number | undefined, string | undefined][] = [];
  open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error("Not open");
    this.sent.push(data as string | ArrayBuffer);
  }
  close(code?: number, reason?: string) {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error("Invalid Web API close code");
    }
    if (this.readyState === 3) return;
    this.closed.push([code, reason]);
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
function socketRequest(query = `apikey=${key}&vsn=2.0.0&eventsPerSecond=5`, headers: HeadersInit = {}): Request {
  return request(`/realtime/v1/websocket?${query}`, { headers: { upgrade: "websocket", ...headers } });
}
function join(token = access, table = "wedding_rsvps", array = true): string {
  const payload = {
    config: {
      broadcast: { ack: false, self: false },
      presence: { key: "", enabled: false },
      postgres_changes: [{ event: "*", schema: "public", table }],
      private: false,
    },
    access_token: token,
  };
  return JSON.stringify(
    array
      ? ["1", "1", "realtime:wedding-rsvp-admin-mock", "phx_join", payload]
      : { join_ref: "1", ref: "1", topic: "realtime:wedding-rsvp-admin-mock", event: "phx_join", payload },
  );
}
function relayFixture() {
  const upstream = new FakeSocket();
  const downstream = new FakeSocket();
  downstream.open();
  const targets: string[] = [];
  const handler = createHandler({
    fetch: (() => {
      throw new Error("No HTTP request expected");
    }) as typeof fetch,
    connect: (url) => {
      targets.push(url);
      return upstream;
    },
    upgrade: () => ({ socket: downstream, response: new Response("mock upgrade") }),
  });
  return { handler, upstream, downstream, targets };
}

Deno.test("WebSocket origin, URL query/key, method and protocol rejection occur before connection", async () => {
  const fixture = relayFixture();
  for (
    const query of [
      `apikey=sb_secret_mock`,
      `apikey=${jwt("service_role")}`,
      `apikey=${key}&vsn=3.0.0`,
      `apikey=${key}&url=wss://evil.example`,
      `apikey=${key}&log_level=debug`,
      `apikey=${key}&eventsPerSecond=100`,
      `apikey=${key}&apikey=${key}`,
    ]
  ) {
    equal((await fixture.handler(socketRequest(query))).status, 404);
  }
  equal((await fixture.handler(socketRequest(undefined, { origin: "https://evil.example" }))).status, 403);
  equal(
    (await fixture.handler(socketRequest(undefined, { authorization: `Bearer ${jwt("service_role")}` }))).status,
    403,
  );
  equal((await fixture.handler(socketRequest(undefined, { apikey: "sb_secret_mock" }))).status, 403);
  equal((await fixture.handler(socketRequest(undefined, { "sec-websocket-protocol": "secret-token" }))).status, 400);
  equal(fixture.targets.length, 0);
});

Deno.test("WebSocket relays raw protocol 1/2 frames in order, refresh tokens and server binary", async () => {
  const fixture = relayFixture();
  try {
    equal((await fixture.handler(socketRequest())).status, 200);
    equal(fixture.targets, [
      `wss://xnqgblzvcltiomqfecsn.supabase.co/realtime/v1/websocket?apikey=${key}&vsn=2.0.0&eventsPerSecond=5`,
    ]);
    const first = join();
    const second = join(access, "wedding_rsvps", false);
    fixture.downstream.message(first);
    fixture.downstream.message(second);
    equal(fixture.upstream.sent, []);
    fixture.upstream.open();
    equal(fixture.upstream.sent, [first, second]);
    const refresh = JSON.stringify(["1", "2", "realtime:wedding-rsvp-admin-mock", "access_token", {
      access_token: access,
    }]);
    fixture.downstream.message(refresh);
    equal(fixture.upstream.sent.at(-1), refresh);
    const reply = JSON.stringify(["1", "1", "realtime:wedding-rsvp-admin-mock", "phx_reply", {
      status: "ok",
      response: {},
    }]);
    fixture.upstream.message(reply);
    equal(fixture.downstream.sent[0], reply);
    const binary = new Uint8Array([1, 2, 3]).buffer;
    fixture.upstream.message(binary);
    assert(fixture.downstream.sent[1] === binary);
  } finally {
    fixture.downstream.close(1000);
  }
  equal(fixture.upstream.readyState, 3);
});

Deno.test("WebSocket rejects private credentials, foreign tables, broadcasts and binary client messages", async () => {
  const badFrames = [
    join("sb_secret_mock"),
    join(jwt("service_role")),
    join(access, "another_table"),
    JSON.stringify(["1", "3", "realtime:wedding-rsvp-admin-mock", "broadcast", { event: "write", payload: {} }]),
    JSON.stringify(["1", "4", "realtime:wedding-rsvp-admin-mock", "access_token", {
      access_token: jwt("service_role"),
    }]),
    "x".repeat(65537),
    new ArrayBuffer(2),
  ];
  for (const frame of badFrames) {
    const fixture = relayFixture();
    try {
      await fixture.handler(socketRequest());
      fixture.upstream.open();
      fixture.downstream.message(frame);
      equal(fixture.upstream.sent.length, 0);
      equal(fixture.downstream.readyState, 3);
      equal(fixture.upstream.readyState, 3);
    } finally {
      fixture.downstream.close(1000);
      fixture.upstream.close(1000);
    }
  }
});

Deno.test("WebSocket queue, frame and backpressure bounds close both sockets", async () => {
  const heartbeat = JSON.stringify([null, "1", "phoenix", "heartbeat", {}]);
  for (const scenario of ["queue", "frame", "backpressure", "error"]) {
    const fixture = relayFixture();
    try {
      await fixture.handler(socketRequest());
      if (scenario === "queue") { for (let n = 0; n < 17; n++) fixture.downstream.message(heartbeat); }
      else {
        fixture.upstream.open();
        if (scenario === "frame") fixture.upstream.message("x".repeat(65537));
        if (scenario === "backpressure") {
          fixture.upstream.bufferedAmount = 262145;
          fixture.downstream.message(heartbeat);
        }
        if (scenario === "error") fixture.upstream.dispatchEvent(new Event("error", { cancelable: true }));
      }
      equal(fixture.downstream.readyState, 3);
      equal(fixture.upstream.readyState, 3);
    } finally {
      fixture.downstream.close(1000);
      fixture.upstream.close(1000);
    }
  }
});

Deno.test("WebSocket connection cap recovers after close and failed upgrade cleans upstream", async () => {
  const sockets: FakeSocket[] = [];
  const handler = createHandler({
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    upgrade: () => {
      const socket = new FakeSocket();
      socket.open();
      sockets.push(socket);
      return { socket, response: new Response("mock upgrade") };
    },
  });
  try {
    for (let n = 0; n < 64; n++) equal((await handler(socketRequest())).status, 200);
    equal((await handler(socketRequest())).status, 503);
    equal(sockets.length, 128);
    sockets[1].close(1000);
    equal((await handler(socketRequest())).status, 200);
  } finally {
    for (const socket of sockets) socket.close(1000);
  }
  const failed = new FakeSocket();
  const failingHandler = createHandler({
    connect: () => failed,
    upgrade: () => {
      throw new Error("Failed upgrade");
    },
  });
  equal((await failingHandler(socketRequest())).status, 502);
  equal(failed.readyState, 3);
});

Deno.test("bundled Supabase SDK anonymous/password/refresh/user/logout/RPC/select use compatible HTTP requests", async () => {
  const { createClient } = await import("../../assets/vendor/supabase-browser.js");
  const paths: string[] = [];
  const session = (anonymous: boolean) => ({
    access_token: access,
    refresh_token: "mock-refresh",
    token_type: "bearer",
    expires_in: 3600,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      aud: "authenticated",
      email: anonymous ? "" : "admin@example.com",
      is_anonymous: anonymous,
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-10-07T00:00:00Z",
    },
  });
  const handler = createHandler({
    fetch: ((input) => {
      const url = new URL(String(input));
      paths.push(url.pathname + url.search);
      if (url.pathname === "/auth/v1/signup") return Promise.resolve(json(session(true)));
      if (url.pathname === "/auth/v1/token") return Promise.resolve(json(session(false)));
      if (url.pathname === "/auth/v1/user") return Promise.resolve(json(session(false).user));
      if (url.pathname === "/auth/v1/logout") return Promise.resolve(new Response(null, { status: 204 }));
      if (url.pathname === "/rest/v1/wedding_rsvps") return Promise.resolve(json([]));
      return Promise.resolve(json({ authorized: true }));
    }) as typeof fetch,
  });
  type Result = Promise<{ error: unknown }>;
  type Client = {
    auth: {
      signInAnonymously(): Result;
      signInWithPassword(input: { email: string; password: string }): Result;
      refreshSession(): Result;
      getUser(): Result;
      signOut(options: { scope: string }): Result;
      stopAutoRefresh(): unknown;
    };
    rpc(name: string, params: object): Result;
    from(
      table: string,
    ): { select(fields: string): { order(field: string, options: object): { limit(count: number): Result } } };
    removeAllChannels(): Promise<unknown>;
  };
  // The vendored minified JavaScript has no usable inferred TypeScript declarations.
  const client = createClient("https://wedding-proxy.example", key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const original = new Request(input, init);
        const headers = new Headers(original.headers);
        headers.set("origin", origin);
        return await handler(new Request(original, { headers }));
      },
    },
  }) as unknown as Client;
  try {
    equal((await client.auth.signInAnonymously()).error, null);
    equal(
      (await client.auth.signInWithPassword({ email: "admin@example.com", password: "mock-password" })).error,
      null,
    );
    equal((await client.auth.refreshSession()).error, null);
    equal((await client.auth.getUser()).error, null);
    equal((await client.rpc("authorize_wedding_admin", {})).error, null);
    equal(
      (await client.from("wedding_rsvps").select("id,name,people,created_at,submitted_at").order("submitted_at", {
        ascending: false,
      }).limit(100)).error,
      null,
    );
    equal((await client.auth.signOut({ scope: "local" })).error, null);
    for (
      const path of [
        "/auth/v1/signup",
        "/auth/v1/token?grant_type=password",
        "/auth/v1/token?grant_type=refresh_token",
        "/auth/v1/user",
        "/auth/v1/logout?scope=local",
        "/rest/v1/rpc/authorize_wedding_admin",
      ]
    ) assert(paths.includes(path));
  } finally {
    await client.removeAllChannels();
    client.auth.stopAutoRefresh();
  }
});
