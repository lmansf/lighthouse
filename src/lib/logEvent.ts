/**
 * Client-side telemetry helper.
 *
 * Fire-and-forget POST to /api/event, which stamps the event with the contact id
 * and experiment variants server-side. Best-effort by design: it never throws and
 * never blocks the UI, so callers can `void logEvent(...)` at any interaction.
 */
export function logEvent(name: string, props: Record<string, unknown> = {}): void {
  try {
    void fetch("/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, props }),
      keepalive: true, // survive a navigation/unload (e.g. first_query before route change)
    }).catch(() => {});
  } catch {
    /* telemetry must never break the UI */
  }
}
