/**
 * Welcome-registration contact shape + config check.
 *
 * The contact fields are captured by the welcome form and stored on the trial
 * row in Supabase when a trial is minted (see `license.ts` → `startTrial`).
 *
 *   SUPABASE_URL                  https://<project>.supabase.co
 *   SUPABASE_ANON_KEY             anon key (welcome-form "configured" check)
 *   SUPABASE_SERVICE_ROLE_KEY     server-side key for license rows
 *   SUPABASE_REGISTRATIONS_TABLE  table name (default: "registrations")
 *
 * Table columns: first_name, last_name, email, do_not_contact (bool), city,
 * state, plus the trial-license columns guid, trial_start, trial_end,
 * license_key (see docs/registration.md).
 */
export interface Registration {
  firstName: string;
  lastName: string;
  email: string;
  doNotContact: boolean;
  city: string;
  state: string;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim()),
  );
}
