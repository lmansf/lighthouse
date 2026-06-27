/**
 * Welcome-registration submission. Inserts the form into a Supabase table via
 * its REST API (no SDK dependency). Configured entirely by env so the app runs
 * without Supabase — the form's Skip path always works, and Submit reports a
 * clear "not configured" status rather than failing hard.
 *
 *   SUPABASE_URL                  https://<project>.supabase.co
 *   SUPABASE_ANON_KEY             the project anon (or service-role) key
 *   SUPABASE_REGISTRATIONS_TABLE  table name (default: "registrations")
 *
 * Expected table columns: first_name, last_name, email, do_not_contact (bool),
 * city, state.
 */
export interface Registration {
  firstName: string;
  lastName: string;
  email: string;
  doNotContact: boolean;
  city: string;
  state: string;
}

export type RegistrationResult =
  | { ok: true }
  | { ok: false; reason: "not-configured" | "rejected"; detail?: string };

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_ANON_KEY?.trim());
}

export async function submitRegistration(r: Registration): Promise<RegistrationResult> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  const table = process.env.SUPABASE_REGISTRATIONS_TABLE?.trim() || "registrations";
  if (!url || !key) return { ok: false, reason: "not-configured" };

  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: key,
      authorization: `Bearer ${key}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      first_name: r.firstName,
      last_name: r.lastName,
      email: r.email,
      do_not_contact: r.doNotContact,
      city: r.city,
      state: r.state,
    }),
  });

  if (!res.ok) {
    return { ok: false, reason: "rejected", detail: (await res.text()).slice(0, 300) };
  }
  return { ok: true };
}
