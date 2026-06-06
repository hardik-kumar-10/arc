import { describe, it, expect } from "vitest";
import { readJson } from "./read-json";
import { AppError } from "./errors";

const post = (body?: BodyInit) =>
  new Request("http://localhost/x", { method: "POST", body });

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    throw new Error("expected throw");
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

describe("readJson", () => {
  it("parses valid JSON", async () => {
    await expect(readJson(post(JSON.stringify({ a: 1 })))).resolves.toEqual({ a: 1 });
  });

  it("empty body → BAD_REQUEST", async () => {
    expect(await codeOf(() => readJson(post()))).toBe("BAD_REQUEST");
  });

  it("non-JSON body → BAD_REQUEST", async () => {
    expect(await codeOf(() => readJson(post("not json")))).toBe("BAD_REQUEST");
  });

  it("oversized body → PAYLOAD_TOO_LARGE, measured in BYTES not string length", async () => {
    // 3 emoji = 6 UTF-16 code units but 12 bytes. With a cap of 8, a string-length check
    // would wrongly pass; a byte check correctly rejects.
    const body = "😀😀😀";
    expect(body.length).toBe(6);
    expect(await codeOf(() => readJson(post(body), 8))).toBe("PAYLOAD_TOO_LARGE");
  });

  it("aborts mid-stream over the cap by CANCELLING the source (not draining it)", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20)); // already over the cap of 8
      },
      pull(controller) {
        // A reader that kept draining would consume an unbounded tail here.
        controller.enqueue(new Uint8Array(1000));
      },
      cancel() {
        cancelled = true; // the reader signalled "stop" early
      },
    });
    const req = new Request("http://localhost/x", {
      method: "POST",
      body: stream,
      // @ts-expect-error — Node/undici requires duplex for a stream body
      duplex: "half",
    });

    expect(await codeOf(() => readJson(req, 8))).toBe("PAYLOAD_TOO_LARGE");
    expect(cancelled).toBe(true); // aborted via cancel(), did not read to completion
  });
});
