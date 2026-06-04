import { describe, it, expect } from "vitest";
import { compileConfig } from "./compiler";
import type { AppConfig, Diagnostic } from "./types";

const codes = (d: Diagnostic[]) => d.map((x) => x.code);
const hasCode = (d: Diagnostic[], code: string) => d.some((x) => x.code === code);

describe("compileConfig — valid round-trip", () => {
  it("a fully valid config round-trips unchanged with no diagnostics", () => {
    const valid: AppConfig = {
      app: { name: "Billing" },
      entities: [
        {
          name: "Customer",
          fields: [
            { name: "title", type: "string", required: true },
            { name: "tier", type: "enum", values: ["free", "pro"], default: "free" },
          ],
        },
        {
          name: "Invoice",
          fields: [
            { name: "amount", type: "number" },
            { name: "customer", type: "reference", ref: "Customer" },
          ],
        },
      ],
      workflows: [
        {
          trigger: { event: "onCreate", entity: "Invoice" },
          actions: [{ type: "sendEmail", to: "owner" }],
        },
      ],
      pages: [
        {
          path: "/invoices",
          title: "Invoices",
          components: [{ type: "Table", props: { entity: "Invoice" }, children: [{ type: "Row" }] }],
        },
      ],
    };

    const result = compileConfig(valid);
    expect(result.diagnostics).toEqual([]);
    expect(result.config).toEqual(valid);
  });

  it("resolves a forward reference (ref to an entity defined later)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [
        { name: "Comment", fields: [{ name: "post", type: "reference", ref: "Post" }] },
        { name: "Post", fields: [{ name: "title", type: "string" }] },
      ],
    });
    expect(hasCode(result.diagnostics, "REF_UNKNOWN_ENTITY")).toBe(false);
    expect(result.config.entities[0]?.fields[0]).toMatchObject({ type: "reference", ref: "Post" });
  });
});

describe("compileConfig — never throws (fuzz)", () => {
  const garbage: unknown[] = [
    null,
    undefined,
    42,
    "a string",
    [1, 2, 3],
    true,
    { entities: "nope", workflows: 5, pages: {} },
    { app: 7, entities: [null, 1, { name: 1 }], workflows: [null], pages: [null] },
    { entities: [{ name: "A", fields: [{ name: "x", type: "??" }, 3, null] }] },
  ];

  for (const input of garbage) {
    it(`returns a valid AppConfig for ${JSON.stringify(input) ?? "undefined"}`, () => {
      const result = compileConfig(input);
      expect(() => result).not.toThrow();
      expect(Array.isArray(result.config.entities)).toBe(true);
      expect(Array.isArray(result.config.workflows)).toBe(true);
      expect(Array.isArray(result.config.pages)).toBe(true);
      expect(typeof result.config.app.name).toBe("string");
      expect(result.config.app.name.length).toBeGreaterThan(0);
    });
  }

  it("non-object input → empty valid config + CONFIG_NOT_OBJECT", () => {
    const result = compileConfig(null);
    expect(result.config).toEqual({ app: { name: "Untitled" }, entities: [], workflows: [], pages: [] });
    expect(codes(result.diagnostics)).toEqual(["CONFIG_NOT_OBJECT"]);
  });
});

describe("compileConfig — app normalization", () => {
  it("missing app.name defaults to Untitled with APP_NAME_DEFAULTED", () => {
    const result = compileConfig({ app: {} });
    expect(result.config.app.name).toBe("Untitled");
    expect(hasCode(result.diagnostics, "APP_NAME_DEFAULTED")).toBe(true);
  });

  it("strips unknown app keys", () => {
    const result = compileConfig({ app: { name: "Ok", color: "red" } });
    expect(result.config.app).toEqual({ name: "Ok" });
    expect(hasCode(result.diagnostics, "APP_UNKNOWN_KEYS")).toBe(true);
  });
});

describe("compileConfig — entity & field rules", () => {
  it("drops a nameless entity (ENTITY_NO_NAME)", () => {
    const result = compileConfig({ app: { name: "X" }, entities: [{ fields: [] }] });
    expect(result.config.entities).toHaveLength(0);
    expect(hasCode(result.diagnostics, "ENTITY_NO_NAME")).toBe(true);
  });

  it("dedupes a duplicate entity name, keeping the first (ENTITY_DUPLICATE)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [
        { name: "A", fields: [{ name: "first", type: "string" }] },
        { name: "A", fields: [{ name: "second", type: "string" }] },
      ],
    });
    expect(result.config.entities).toHaveLength(1);
    expect(result.config.entities[0]?.fields[0]?.name).toBe("first");
    expect(hasCode(result.diagnostics, "ENTITY_DUPLICATE")).toBe(true);
  });

  it("keeps an entity with zero fields but warns (ENTITY_NO_FIELDS)", () => {
    const result = compileConfig({ app: { name: "X" }, entities: [{ name: "Empty", fields: [] }] });
    expect(result.config.entities).toHaveLength(1);
    expect(hasCode(result.diagnostics, "ENTITY_NO_FIELDS")).toBe(true);
  });

  it("drops a field with an unknown type (FIELD_UNKNOWN_TYPE)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "bad", type: "datetime" }, { name: "good", type: "string" }] }],
    });
    expect(result.config.entities[0]?.fields.map((f) => f.name)).toEqual(["good"]);
    expect(hasCode(result.diagnostics, "FIELD_UNKNOWN_TYPE")).toBe(true);
  });

  it("drops a reserved field name (FIELD_RESERVED_NAME)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "id", type: "string" }, { name: "title", type: "string" }] }],
    });
    expect(result.config.entities[0]?.fields.map((f) => f.name)).toEqual(["title"]);
    expect(hasCode(result.diagnostics, "FIELD_RESERVED_NAME")).toBe(true);
  });

  it("dedupes a duplicate field name within an entity (FIELD_DUPLICATE)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "x", type: "string" }, { name: "x", type: "number" }] }],
    });
    expect(result.config.entities[0]?.fields).toHaveLength(1);
    expect(result.config.entities[0]?.fields[0]?.type).toBe("string");
    expect(hasCode(result.diagnostics, "FIELD_DUPLICATE")).toBe(true);
  });

  it("coerces non-boolean required to false (FIELD_REQUIRED_DEFAULTED)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "x", type: "string", required: "yes" }] }],
    });
    expect(result.config.entities[0]?.fields[0]?.required).toBeUndefined();
    expect(hasCode(result.diagnostics, "FIELD_REQUIRED_DEFAULTED")).toBe(true);
  });

  it("drops an enum field with no values (ENUM_NO_VALUES)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "e", type: "enum", values: [] }] }],
    });
    expect(result.config.entities[0]?.fields).toHaveLength(0);
    expect(hasCode(result.diagnostics, "ENUM_NO_VALUES")).toBe(true);
  });

  it("drops a reference to a missing entity (REF_UNKNOWN_ENTITY)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "r", type: "reference", ref: "Ghost" }] }],
    });
    expect(result.config.entities[0]?.fields).toHaveLength(0);
    expect(hasCode(result.diagnostics, "REF_UNKNOWN_ENTITY")).toBe(true);
  });

  it("drops an incompatible default but keeps the field (DEFAULT_DROPPED)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "n", type: "number", default: "not-a-number" }] }],
    });
    const field = result.config.entities[0]?.fields[0];
    expect(field?.name).toBe("n");
    expect(field?.default).toBeUndefined();
    expect(hasCode(result.diagnostics, "DEFAULT_DROPPED")).toBe(true);
  });
});

describe("compileConfig — workflow rules", () => {
  it("drops a workflow targeting an unknown entity (WORKFLOW_UNKNOWN_ENTITY)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "x", type: "string" }] }],
      workflows: [{ trigger: { event: "onCreate", entity: "Nope" }, actions: [{ type: "x" }] }],
    });
    expect(result.config.workflows).toHaveLength(0);
    expect(hasCode(result.diagnostics, "WORKFLOW_UNKNOWN_ENTITY")).toBe(true);
  });

  it("drops a workflow left with no valid actions (WORKFLOW_NO_ACTIONS)", () => {
    const result = compileConfig({
      app: { name: "X" },
      entities: [{ name: "A", fields: [{ name: "x", type: "string" }] }],
      workflows: [{ trigger: { event: "onCreate", entity: "A" }, actions: [{ noType: true }] }],
    });
    expect(result.config.workflows).toHaveLength(0);
    expect(hasCode(result.diagnostics, "WORKFLOW_ACTION_DROPPED")).toBe(true);
    expect(hasCode(result.diagnostics, "WORKFLOW_NO_ACTIONS")).toBe(true);
  });
});

describe("compileConfig — page & component rules", () => {
  it("drops a component node missing a type but preserves its valid sibling", () => {
    const result = compileConfig({
      app: { name: "X" },
      pages: [{ path: "/p", components: [{ notType: 1 }, { type: "Button" }] }],
    });
    expect(result.config.pages[0]?.components).toEqual([{ type: "Button" }]);
    expect(hasCode(result.diagnostics, "COMPONENT_NO_TYPE")).toBe(true);
  });

  it("dedupes a duplicate page path (PAGE_DUPLICATE_PATH)", () => {
    const result = compileConfig({
      app: { name: "X" },
      pages: [
        { path: "/dup", title: "first" },
        { path: "/dup", title: "second" },
      ],
    });
    expect(result.config.pages).toHaveLength(1);
    expect(result.config.pages[0]?.title).toBe("first");
    expect(hasCode(result.diagnostics, "PAGE_DUPLICATE_PATH")).toBe(true);
  });

  it("drops a subtree nested past the depth cap (COMPONENT_MAX_DEPTH)", () => {
    // Build a chain of nested children far deeper than the cap (50).
    let node: Record<string, unknown> = { type: "Leaf" };
    for (let i = 0; i < 60; i++) node = { type: "Box", children: [node] };
    const result = compileConfig({ app: { name: "X" }, pages: [{ path: "/deep", components: [node] }] });
    expect(hasCode(result.diagnostics, "COMPONENT_MAX_DEPTH")).toBe(true);
  });
});

describe("compileConfig — bounded output", () => {
  it("caps diagnostics at 1000 with a final DIAGNOSTICS_TRUNCATED and never throws", () => {
    // Thousands of nameless entities each emit one ENTITY_NO_NAME error.
    const entities = Array.from({ length: 5000 }, () => ({ fields: [] }));
    const result = compileConfig({ app: { name: "X" }, entities });
    expect(result.diagnostics).toHaveLength(1000);
    expect(result.diagnostics.at(-1)?.code).toBe("DIAGNOSTICS_TRUNCATED");
  });
});
