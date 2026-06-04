import { z } from "zod";
import { withRoute } from "@/server/http/with-route";
import { ok } from "@/server/http/envelope";
import { readJson } from "@/server/http/read-json";
import { AppError } from "@/server/http/errors";
import { configService } from "@/server/config/service";
import { oneParam } from "@/lib/params";

// The config PAYLOAD is intentionally `unknown` — it goes straight to the compiler, never a
// strict parse. Only the request ENVELOPE (the wrapper) is validated here.
const publishBody = z.object({ config: z.unknown(), strict: z.boolean().optional() });

// POST /api/apps/[appId]/config — publish a config (lenient by default, strict on request).
export const POST = withRoute(async (req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const body = await readJson(req);
  const parsed = publishBody.safeParse(body);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid request body", z.flattenError(parsed.error));
  }
  const result = await configService.publishConfig({
    ownerId: ctx.ownerId,
    appId,
    rawConfig: parsed.data.config,
    strict: parsed.data.strict,
  });
  return ok(result, { requestId: ctx.requestId });
});

// GET /api/apps/[appId]/config — the active normalized config + version + diagnostics.
export const GET = withRoute(async (_req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const result = await configService.getActiveConfig({ ownerId: ctx.ownerId, appId });
  return ok(result, { requestId: ctx.requestId });
});
