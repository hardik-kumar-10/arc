import { withRoute } from "@/server/http/with-route";
import { ok } from "@/server/http/envelope";
import { AppError } from "@/server/http/errors";
import { configService } from "@/server/config/service";
import { oneParam } from "@/lib/params";

// GET /api/apps/[appId]/config/versions/[version] — a specific historical version's full config.
export const GET = withRoute(async (_req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const version = Number(oneParam(ctx.params.version));
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError("BAD_REQUEST", "Version must be a positive integer");
  }
  const result = await configService.getConfigVersion({ ownerId: ctx.ownerId, appId, version });
  return ok(result, { requestId: ctx.requestId });
});
