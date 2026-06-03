export function logRequest(entry: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}): void {
  console.log(JSON.stringify({ level: "info", type: "request", ...entry }));
}

export function logError(entry: { requestId: string; error: unknown }): void {
  const e = entry.error;
  console.error(
    JSON.stringify({
      level: "error",
      type: "unhandled",
      requestId: entry.requestId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    }),
  );
}
