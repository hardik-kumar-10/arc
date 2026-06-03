import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";

// Prisma 7 instantiates through a driver adapter; the connection string is read here.
// DATABASE_URL is not yet provisioned — this singleton is unused until Phase 4 (CRUD),
// and the `?? ""` keeps types honest without crashing at import time.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
