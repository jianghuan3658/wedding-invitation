import { createHandler } from "./main.ts";
import { checkWeddingServiceHealth, HEALTH_CRON_NAME, HEALTH_CRON_SCHEDULE } from "./health-maintenance.ts";

// Deno Deploy discovers top-level definitions. Keep this entry out of mock imports.
Deno.cron(HEALTH_CRON_NAME, HEALTH_CRON_SCHEDULE, { backoffSchedule: [60_000, 300_000] }, async () => {
  await checkWeddingServiceHealth();
});

Deno.serve(createHandler());
