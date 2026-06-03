import { withRoute } from "@/server/http/with-route";
import { ok } from "@/server/http/envelope";

export const GET = withRoute(
  (_req, ctx) =>
    ok({ status: "ok", time: new Date().toISOString() }, { requestId: ctx.requestId }),
  { auth: false },
);
