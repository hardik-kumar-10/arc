import { z } from "zod";
import { withRoute } from "@/server/http/with-route";
import { ok } from "@/server/http/envelope";
import { readJson } from "@/server/http/read-json";
import { AppError } from "@/server/http/errors";
import { configService } from "@/server/config/service";

const createAppBody = z.object({ name: z.string() });

// POST /api/apps — create an app owned by the caller.
export const POST = withRoute(async (req, ctx) => {
  const body = await readJson(req);
  const parsed = createAppBody.safeParse(body);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid request body", z.flattenError(parsed.error));
  }
  const app = await configService.createApp({ ownerId: ctx.ownerId, name: parsed.data.name });
  return ok(app, { status: 201, requestId: ctx.requestId });
});

// GET /api/apps — list the caller's apps.
export const GET = withRoute(async (_req, ctx) => {
  const apps = await configService.listApps({ ownerId: ctx.ownerId });
  return ok(apps, { requestId: ctx.requestId });
});
