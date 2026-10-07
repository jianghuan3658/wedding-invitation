import { createHandler, SERVICE_HEALTH_PATH, UPSTREAM } from "./main.ts";
import { checkWeddingServiceHealth, HEALTH_CRON_NAME, HEALTH_CRON_SCHEDULE } from "./health-maintenance.ts";

const publicKey = "sb_publishable_mock_key";
const checkedAt = "2026-10-07T02:03:04.005Z";
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Health maintenance assertion failed");
}
async function rejected(operation: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    equal((error as Error).message, expected);
    return;
  }
  throw new Error("Expected rejection");
}
function healthRequest(body: string, path = SERVICE_HEALTH_PATH, method = "POST"): Request {
  return new Request("https://proxy.example" + path, {
    method,
    headers: {
      origin: "https://jianghuan3658.github.io",
      apikey: publicKey,
      authorization: `Bearer ${publicKey}`,
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body } : {}),
  });
}
function result(body: unknown = { ok: true, checkedAt }, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.test("service health proxy accepts only POST empty JSON and no query", async () => {
  let calls = 0;
  const handler = createHandler({
    fetch: (() => {
      calls++;
      return Promise.resolve(result());
    }) as typeof fetch,
  });
  const response = await handler(healthRequest("{}"));
  equal(response.status, 200);
  equal(await response.json(), { ok: true, checkedAt });
  equal(response.headers.get("cache-control"), "no-store");
  for (const body of ['{"name":"宾客"}', '{"count":1}', "[]", "null", '"value"']) {
    equal((await handler(healthRequest(body))).status, 400);
  }
  equal((await handler(healthRequest("{}", SERVICE_HEALTH_PATH + "?target=other"))).status, 404);
  equal((await handler(healthRequest("", SERVICE_HEALTH_PATH, "GET"))).status, 405);
  equal(calls, 1);
});

Deno.test("six-hour maintenance issues a real fixed PostgreSQL RPC with only public apikey", async () => {
  equal(HEALTH_CRON_NAME, "wedding-service-health");
  equal(HEALTH_CRON_SCHEDULE.split(" "), ["0", "*/6", "*", "*", "*"]);
  let calls = 0;
  const fetched = await checkWeddingServiceHealth(
    ((url, options) => {
      calls++;
      equal(String(url), UPSTREAM + SERVICE_HEALTH_PATH);
      equal(options?.method, "POST");
      equal(options?.body, "{}");
      equal(options?.redirect, "error");
      equal(options?.cache, "no-store");
      const headers = new Headers(options?.headers);
      equal(headers.get("apikey"), publicKey);
      equal(headers.get("authorization"), null);
      equal(headers.get("cookie"), null);
      equal(headers.get("content-type"), "application/json");
      equal(options?.signal instanceof AbortSignal, true);
      return Promise.resolve(result());
    }) as typeof fetch,
    publicKey,
  );
  equal(fetched, { ok: true, checkedAt });
  equal(calls, 1);
});

Deno.test("maintenance refuses non-public credentials before any network operation", async () => {
  const fetcher = (() => {
    throw new Error("Must not fetch");
  }) as typeof fetch;
  for (const key of ["", "sb_secret_mock", "eyJhbGciOiJIUzI1NiJ9.e30.signature", "sb_publishable_" + "x".repeat(600)]) {
    await rejected(() => checkWeddingServiceHealth(fetcher, key), "SERVICE_HEALTH_PUBLIC_KEY_REQUIRED");
  }
});

Deno.test("maintenance detects paused/network/invalid/leaking health responses without logging their contents", async () => {
  for (
    const response of [
      () => result({ ok: false, checkedAt }),
      () => result({ ok: true, checkedAt: "not a timestamp" }),
      () => result({ ok: true, checkedAt, guestNames: ["宾客"] }),
      () => result({ ok: true, checkedAt }, 503),
      () => result({ private: "x".repeat(4097) }),
      () => new Response("<html>private diagnostic</html>", { headers: { "content-type": "text/html" } }),
      () => {
        throw new Error("private transport diagnostic");
      },
    ]
  ) {
    const fetcher = (() => Promise.resolve(response())) as typeof fetch;
    await rejected(() => checkWeddingServiceHealth(fetcher, publicKey), "SERVICE_HEALTH_FAILED");
  }
});
