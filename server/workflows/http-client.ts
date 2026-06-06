// server/workflows/http-client.ts — the real WorkflowHttpClient (used at the composition root).
//
// A thin POST-with-timeout over global `fetch`. Tests inject a stub instead of this, so workflow
// tests stay network-free. A timeout aborts the request, surfacing as a thrown error that the runner
// catches and logs as a `failed` action.

import type { WorkflowHttpClient } from "./types";

export class FetchHttpClient implements WorkflowHttpClient {
  async post(url: string, body: unknown, opts?: { timeoutMs?: number }): Promise<{ status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
}
