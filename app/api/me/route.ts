import { withRoute } from "@/server/http/with-route";
import { ok } from "@/server/http/envelope";

// Authed by default → ctx.ownerId is typed `string` (non-null), enforced by the pipeline.
export const GET = withRoute((_req, ctx) =>
  ok({ ownerId: ctx.ownerId }, { requestId: ctx.requestId }),
);
