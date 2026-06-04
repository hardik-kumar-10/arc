import { describe, it, expect } from "vitest";
import { buildEntityValidator } from "./build-validator";
import type { ValidationOutcome } from "./types";
import type { EntityDef } from "@/server/config/types";

const RESERVED = ["id", "ownerId", "version", "createdAt", "updatedAt"];

// A normalized entity exercising every field type, both required and defaulted/optional.
const entity: EntityDef = {
  name: "Task",
  fields: [
    { name: "title", type: "string", required: true }, // required, no default
    { name: "count", type: "number" }, // optional
    { name: "done", type: "boolean", default: false }, // default
    { name: "status", type: "enum", values: ["open", "closed"], default: "open" }, // enum + default
    { name: "startsAt", type: "date", default: "2024-01-01" }, // date default stored as string
    { name: "owner", type: "reference", ref: "User" }, // optional reference
  ],
};

const v = buildEntityValidator(entity);

function expectOk(r: ValidationOutcome): Record<string, unknown> {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok:true");
  return r.data;
}
function expectFail(r: ValidationOutcome): { fieldErrors: Record<string, string[]>; formErrors: string[] } {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected ok:false");
  return { fieldErrors: r.fieldErrors, formErrors: r.formErrors };
}

describe("valid create", () => {
  it("passes, applies defaults, coerces, strips unknown keys, omits absent optionals", () => {
    const data = expectOk(v.validate({ title: "Hi", count: "42", extra: "nope" }, "create"));
    expect(data.title).toBe("Hi");
    expect(data.count).toBe(42); // coerced "42" -> 42
    expect(data.done).toBe(false); // default
    expect(data.status).toBe("open"); // enum default
    expect(data.startsAt).toBeInstanceOf(Date); // prefault coerced the string default to a Date
    expect(data).not.toHaveProperty("extra"); // unknown key stripped (no .strict())
    expect(data).not.toHaveProperty("owner"); // absent optional omitted
  });

  it("date default comes back as a Date, not the raw string (prefault, not default)", () => {
    const data = expectOk(v.validate({ title: "x" }, "create"));
    expect(data.startsAt).toBeInstanceOf(Date);
    expect((data.startsAt as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("system-column safety", () => {
  it("never emits a reserved system-column key", () => {
    const data = expectOk(v.validate({ title: "x", count: 1, owner: "u1" }, "create"));
    for (const key of Object.keys(data)) expect(RESERVED).not.toContain(key);
  });
});

describe("required & optional (create vs update)", () => {
  it("missing required in create -> fail with a per-field message", () => {
    const { fieldErrors } = expectFail(v.validate({ count: 1 }, "create"));
    expect(fieldErrors.title?.length).toBeGreaterThan(0);
  });

  it("missing required in update -> ok (partial; not re-required)", () => {
    expectOk(v.validate({ count: 5 }, "update"));
  });

  it("update injects NO defaults for absent fields", () => {
    const data = expectOk(v.validate({ title: "x" }, "update"));
    expect(data).not.toHaveProperty("done");
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("startsAt");
  });

  it("absent optional with no default -> ok, key omitted", () => {
    const data = expectOk(v.validate({ title: "x" }, "create"));
    expect(data).not.toHaveProperty("count");
  });
});

describe("coercion successes", () => {
  it("'42' -> 42, '2023-05-05' -> Date, 1 -> true, 'true' -> true, number -> string", () => {
    const data = expectOk(
      v.validate({ title: 99, count: "42", startsAt: "2023-05-05", done: 1 }, "create"),
    );
    expect(data.title).toBe("99"); // number coerced to string
    expect(data.count).toBe(42);
    expect(data.startsAt).toBeInstanceOf(Date);
    expect(data.done).toBe(true); // 1 -> true
    expect(expectOk(v.validate({ title: "x", done: "true" }, "create")).done).toBe(true);
  });
});

describe("coercion traps (must fail, never corrupt)", () => {
  it("'false' -> false, not true", () => {
    expect(expectOk(v.validate({ title: "x", done: "false" }, "create")).done).toBe(false);
  });

  it.each([["abc"], [""], ["  "], [null], [true], [[]], [{}]])(
    "number rejects %j instead of leaking 0/1/NaN",
    (bad) => {
      const { fieldErrors } = expectFail(v.validate({ title: "x", count: bad }, "create"));
      expect(fieldErrors.count?.length).toBeGreaterThan(0);
    },
  );

  it.each([[null], [true], ["abc"], [{}]])("date rejects %j instead of Date(0)/Date(1)", (bad) => {
    const { fieldErrors } = expectFail(v.validate({ title: "x", startsAt: bad }, "create"));
    expect(fieldErrors.startsAt?.length).toBeGreaterThan(0);
  });

  it.each([[{}], [[]], [null]])("string rejects %j", (bad) => {
    const { fieldErrors } = expectFail(v.validate({ title: bad }, "create"));
    expect(fieldErrors.title?.length).toBeGreaterThan(0);
  });
});

describe("enum", () => {
  it("exact-case in-set passes", () => {
    expect(expectOk(v.validate({ title: "x", status: "closed" }, "create")).status).toBe("closed");
  });
  it("wrong-case fails", () => {
    expectFail(v.validate({ title: "x", status: "Open" }, "create"));
  });
  it("out-of-set fails", () => {
    const { fieldErrors } = expectFail(v.validate({ title: "x", status: "archived" }, "create"));
    expect(fieldErrors.status?.length).toBeGreaterThan(0);
  });
});

describe("reference", () => {
  it("non-empty string passes", () => {
    expect(expectOk(v.validate({ title: "x", owner: "user_1" }, "create")).owner).toBe("user_1");
  });
  it("empty string fails", () => {
    expectFail(v.validate({ title: "x", owner: "" }, "create"));
  });
  it("non-string fails", () => {
    expectFail(v.validate({ title: "x", owner: 123 }, "create"));
  });
});

describe("null is a value, not absent", () => {
  it("explicit null on required field fails", () => {
    expectFail(v.validate({ title: null }, "create"));
  });
  it("explicit null on optional field fails (not treated as omitted)", () => {
    expectFail(v.validate({ title: "x", count: null }, "create"));
  });
});

describe("never throws (fuzz)", () => {
  const garbage: unknown[] = [null, undefined, 42, "x", [], { a: { b: {} } }, true];
  for (const mode of ["create", "update"] as const) {
    for (const input of garbage) {
      it(`${mode} on ${JSON.stringify(input) ?? "undefined"} returns an outcome, never throws`, () => {
        const r = v.validate(input, mode);
        expect(typeof r.ok).toBe("boolean");
      });
    }
  }
});
