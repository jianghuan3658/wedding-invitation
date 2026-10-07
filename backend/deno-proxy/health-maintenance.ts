import publicConfig from "./public-config.json" with { type: "json" };
import { readBounded, SERVICE_HEALTH_PATH, UPSTREAM } from "./main.ts";

export const HEALTH_CRON_SCHEDULE = "0 */6 * * *";
export const HEALTH_CRON_NAME = "wedding-service-health";

/** A concrete PostgreSQL query, using only the same public key already shipped to guests. */
export async function checkWeddingServiceHealth(
  fetchUpstream: typeof fetch = fetch,
  publishableKey = publicConfig.publishableKey,
): Promise<{ ok: true; checkedAt: string }> {
  if (!/^sb_publishable_[A-Za-z0-9_-]{1,496}$/.test(publishableKey)) {
    throw new Error("SERVICE_HEALTH_PUBLIC_KEY_REQUIRED");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchUpstream(UPSTREAM + SERVICE_HEALTH_PATH, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json", accept: "application/json" },
      body: "{}",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (
      response.status !== 200 || !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get("content-type") || "")
    ) {
      throw new Error();
    }
    const result = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 4096)));
    if (
      !result || result.ok !== true || typeof result.checkedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.checkedAt) ||
      !Number.isFinite(Date.parse(result.checkedAt)) ||
      Object.keys(result).some((key) => !["ok", "checkedAt"].includes(key))
    ) {
      throw new Error();
    }
    return { ok: true, checkedAt: result.checkedAt };
  } catch {
    // Cron can report failure without including response bodies or credentials in logs.
    throw new Error("SERVICE_HEALTH_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}
