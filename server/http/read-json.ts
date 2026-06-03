import { Buffer } from "node:buffer";
import { AppError } from "./errors";
import { MAX_BODY_BYTES } from "./limits";

/**
 * Parse a JSON request body, mapping every malformed-input case to a structured 4xx.
 * The size cap is measured in BYTES (not string length), so multi-byte payloads count
 * correctly. Note: the body is fully buffered before measurement — streaming/abort is a
 * Phase 7 hardening item; this guard protects correctness, not memory.
 */
export async function readJson<T = unknown>(
  req: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<T> {
  const text = await req.text();
  if (text.length === 0) throw new AppError("BAD_REQUEST", "Request body is empty");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Request body too large");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("BAD_REQUEST", "Request body is not valid JSON");
  }
}
