import { AppError } from "./errors";
import { MAX_BODY_BYTES } from "./limits";

/**
 * Parse a JSON request body, mapping every malformed-input case to a structured 4xx.
 *
 * Phase 7: the body is read by STREAMING from the request and the read ABORTS as soon as accumulated
 * bytes exceed `maxBytes` — the oversized tail is never buffered (memory-safe ingestion). The size cap
 * is measured in BYTES, so multi-byte payloads count correctly. Signature is unchanged from Phase 1,
 * so Phase 2/4 callers are untouched; behavior is preserved: empty -> BAD_REQUEST, non-JSON ->
 * BAD_REQUEST, over cap -> PAYLOAD_TOO_LARGE.
 */
export async function readJson<T = unknown>(req: Request, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const bytes = req.body
    ? await readStreamCapped(req.body, maxBytes)
    : encode(await req.text(), maxBytes); // some runtimes expose no stream for tiny/absent bodies

  if (bytes.byteLength === 0) throw new AppError("BAD_REQUEST", "Request body is empty");

  const text = new TextDecoder("utf-8").decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("BAD_REQUEST", "Request body is not valid JSON");
  }
}

/** Accumulate stream chunks, aborting (and cancelling the stream) the moment the cap is exceeded. */
async function readStreamCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Abort: stop reading and discard the unread remainder rather than buffering it.
        await reader.cancel();
        throw new AppError("PAYLOAD_TOO_LARGE", "Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel() in some runtimes — ignore
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Fallback byte path for the no-stream case: encode, then apply the same byte cap. */
function encode(text: string, maxBytes: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Request body too large");
  }
  return bytes;
}
