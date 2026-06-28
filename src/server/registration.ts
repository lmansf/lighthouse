/**
 * Welcome-registration contact shape + config check.
 *
 * The contact fields are captured by the welcome form and passed to the hosted
 * license Edge Function, which stores them on the trial row (see `license.ts` →
 * `startTrial`). The desktop app holds only the function URL and the public anon
 * key — never the service-role key or LICENSE_SECRET (those live in the Edge
 * Function; see docs/registration.md).
 *
 *   LICENSE_API_URL    https://<project>.supabase.co/functions/v1/license
 *   SUPABASE_ANON_KEY  public key (authorizes the function call)
 *
 * Row columns: first_name, last_name, email, do_not_contact (bool), city, state,
 * plus the license columns guid, license_key, license_type, trial_days,
 * active_days, last_active_day, paid_through, grace_days (see docs).
 */
export interface Registration {
  firstName: string;
  lastName: string;
  email: string;
  doNotContact: boolean;
  city: string;
  state: string;
}

/** Whether trial registration is wired up (hosted license function present). */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.LICENSE_API_URL?.trim());
}
