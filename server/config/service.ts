// server/config/service.ts — the wired ConfigService singleton used by the route handlers.
//
// Routes import `configService` from here; route tests `vi.mock` this module to swap in a stub,
// so the real PrismaConfigRepository (and the DB) never load during handler-level tests.

import { ConfigService } from "./config-service";
import { PrismaConfigRepository } from "./prisma-config-repository";

export const configService = new ConfigService(new PrismaConfigRepository());
