// server/records/service.ts — the wired RecordService singleton used by the route handler.
//
// Routes import `recordService` from here; route tests `vi.mock` this module to swap in a stub, so
// the real Prisma repositories (and the DB) never load during handler-level tests. Mirrors the
// Phase 2 config/service.ts seam.

import { PrismaConfigRepository } from "@/server/config/prisma-config-repository";
import { ConfigActiveReader } from "./active-config-reader";
import { PrismaRecordRepository } from "./prisma-record-repository";
import { RecordService } from "./record-service";

export const recordService = new RecordService(
  new ConfigActiveReader(new PrismaConfigRepository()),
  new PrismaRecordRepository(),
);
