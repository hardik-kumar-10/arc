// app/api/apps/[appId]/data/[entity]/[[...id]]/route.ts — the single generic CRUD handler.
//
// One handler serves every entity defined in the active config. The optional catch-all `[[...id]]`
// distinguishes collection routes (zero segments) from item routes (one segment); two or more
// segments is unsupported (BAD_REQUEST). Each verb resolves params, delegates to the recordService
// seam, and lets thrown AppErrors flow to the withRoute catch -> structured envelope. No 500 for
// any input shape: the service maps every malformed case to a 4xx.

import { withRoute } from "@/server/http/with-route";
import { ok } from "@/server/http/envelope";
import { readJson } from "@/server/http/read-json";
import { AppError } from "@/server/http/errors";
import { recordService } from "@/server/records/service";
import { readResponseMeta } from "@/server/records/serialize";
import { runWithIdempotency, type IdempotentResult } from "@/server/http/idempotency";
import { oneParam } from "@/lib/params";

/** Collapse the optional catch-all into a single id, or null for the collection route. */
function resolveId(raw: string | string[] | undefined): { kind: "collection" } | { kind: "item"; id: string } {
  const segments = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (segments.length === 0) return { kind: "collection" };
  if (segments.length === 1) return { kind: "item", id: segments[0] };
  throw new AppError("BAD_REQUEST", "Nested record ids are not supported");
}

export const POST = withRoute(async (req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const entity = oneParam(ctx.params.entity);
  const target = resolveId(ctx.params.id);
  if (target.kind !== "collection") {
    throw new AppError("BAD_REQUEST", "Cannot POST to a specific record id");
  }
  const body = await readJson(req);

  // Opt-in idempotency: a create carrying an `Idempotency-Key` is safe to retry. Absent header ->
  // behaves exactly as before.
  const idempotencyKey = req.headers.get("idempotency-key") || undefined;
  const produce = async (): Promise<IdempotentResult> => {
    const record = await recordService.create({ ownerId: ctx.ownerId, appId, entity, body });
    return { status: 201, data: record, meta: readResponseMeta(record) };
  };
  const out = idempotencyKey
    ? await runWithIdempotency({ ownerId: ctx.ownerId, key: idempotencyKey, body }, produce)
    : await produce();

  return ok(out.data, { status: out.status, meta: out.meta, requestId: ctx.requestId });
});

export const GET = withRoute(async (req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const entity = oneParam(ctx.params.entity);
  const target = resolveId(ctx.params.id);

  if (target.kind === "item") {
    const record = await recordService.get({ ownerId: ctx.ownerId, appId, entity, id: target.id });
    return ok(record, { meta: readResponseMeta(record), requestId: ctx.requestId });
  }

  const { searchParams } = new URL(req.url);
  const { items, meta } = await recordService.list({ ownerId: ctx.ownerId, appId, entity, searchParams });
  return ok(items, { meta, requestId: ctx.requestId });
});

export const PATCH = withRoute(async (req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const entity = oneParam(ctx.params.entity);
  const target = resolveId(ctx.params.id);
  if (target.kind !== "item") {
    throw new AppError("BAD_REQUEST", "PATCH requires a record id");
  }
  const body = await readJson(req);
  const record = await recordService.update({ ownerId: ctx.ownerId, appId, entity, id: target.id, body });
  return ok(record, { meta: readResponseMeta(record), requestId: ctx.requestId });
});

export const DELETE = withRoute(async (_req, ctx) => {
  const appId = oneParam(ctx.params.appId);
  const entity = oneParam(ctx.params.entity);
  const target = resolveId(ctx.params.id);
  if (target.kind !== "item") {
    throw new AppError("BAD_REQUEST", "DELETE requires a record id");
  }
  const result = await recordService.delete({ ownerId: ctx.ownerId, appId, entity, id: target.id });
  return ok(result, { meta: readResponseMeta(result), requestId: ctx.requestId });
});
