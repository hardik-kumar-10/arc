// server/records/service.ts — the wired RecordService singleton used by the route handler.
//
// Routes import `recordService` from here; route tests `vi.mock` this module to swap in a stub, so
// the real Prisma repositories (and the DB) never load during handler-level tests. Mirrors the
// Phase 2 config/service.ts seam.
//
// This is also the composition root that wires the Phase 6 workflow runner. The runner is injected
// AFTER the service is constructed to break the cycle (service -> runner -> writer -> service): the
// writer adapter calls back into this same service for cascading creates, and into the repo for
// silent self-updates.

import { PrismaConfigRepository } from "@/server/config/prisma-config-repository";
import { builtinActions } from "@/server/workflows/actions";
import { FetchHttpClient } from "@/server/workflows/http-client";
import { RecordServiceWorkflowWriter } from "@/server/workflows/record-writer";
import { WorkflowRunner } from "@/server/workflows/runner";
import { ConfigActiveReader } from "./active-config-reader";
import { PrismaRecordRepository } from "./prisma-record-repository";
import { RecordService } from "./record-service";

const repo = new PrismaRecordRepository();

export const recordService = new RecordService(new ConfigActiveReader(new PrismaConfigRepository()), repo);

const writer = new RecordServiceWorkflowWriter(recordService, repo);
recordService.setWorkflowRunner(new WorkflowRunner(builtinActions, writer, new FetchHttpClient()));
