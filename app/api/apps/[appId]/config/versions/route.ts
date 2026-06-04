import { withRoute } from "@/server/http/with-route";
import { ok } from "@/server/http/envelope";
import { configService } from "@/server/config/service";
import { oneParam } from "@/lib/params";

// GET /api/apps/[appId]/config/versions — version history metadata (newest first).
export const GET = withRoute(async (_req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const versions = await configService.listVersions({ ownerId: ctx.ownerId, appId });
  return ok(versions, { requestId: ctx.requestId });
});
