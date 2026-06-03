import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/auth/context", () => ({ getOwnerContext: vi.fn() }));

import { getOwnerContext } from "@/server/auth/context";
import { GET as health } from "./health/route";
import { GET as me } from "./me/route";

const mockedGetOwner = vi.mocked(getOwnerContext);
const req = (path: string) => new Request(`http://localhost${path}`);

type Envelope = {
  ok: boolean;
  requestId: string;
  data?: { status?: string; time?: string; ownerId?: string };
  error?: { code: string };
};

beforeEach(() => mockedGetOwner.mockReset());

describe("GET /api/health (public)", () => {
  it("returns 200 ok envelope with status and requestId", async () => {
    mockedGetOwner.mockResolvedValue(null);
    const res = await health(req("/api/health"));
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.status).toBe("ok");
    expect(typeof body.data?.time).toBe("string");
    expect(body.requestId).toBeTruthy();
  });
});

describe("GET /api/me (protected)", () => {
  it("unauthenticated → 401 UNAUTHORIZED", async () => {
    mockedGetOwner.mockResolvedValue(null);
    const res = await me(req("/api/me"));
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("authenticated → 200 echoing ownerId", async () => {
    mockedGetOwner.mockResolvedValue("user_abc");
    const res = await me(req("/api/me"));
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(200);
    expect(body.data?.ownerId).toBe("user_abc");
  });
});
