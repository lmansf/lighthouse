// Lighthouse Stripe webhook (Supabase Edge Function, Deno).

//
// Turns a completed Stripe Checkout / subscription into a PAID license on the
// existing registrations row — keyed by the app's guid (passed as Checkout
// `client_reference_id`). The desktop never enters a key: its trial token
// already binds the guid, and `check` reads the row (now license_type='paid'),
// so the app auto-upgrades the next time it polls.
//
// Secrets (supabase secrets set ...):
//   STRIPE_SECRET_KEY            sk_live_… / sk_test_…
//   STRIPE_WEBHOOK_SECRET        whsec_…  (from the webhook endpoint)
//   SUPABASE_URL / SERVICE_ROLE  auto-injected
import Stripe from "https://esm.sh/stripe@17?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-12-18.acacia" });
const TABLE = Deno.env.get("REGISTRATIONS_TABLE") ?? "registrations";
const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

/** Set paid_through (+ stripe ids) on the row for this guid/email. */
async function grantPaid(opts: {
  guid?: string | null;
  email?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  periodEnd: number; // unix seconds
}) {
  const paidThrough = new Date(opts.periodEnd * 1000).toISOString();
  const patch = {
    license_type: "paid",
    paid_through: paidThrough,
    stripe_customer_id: opts.customerId ?? null,
    stripe_subscription_id: opts.subscriptionId ?? null,
  };
  const db = admin();
  // Prefer the exact app install (guid); then the existing subscription row
  // (reliable for renewals, where guid/email may be absent); fall back to email.
  if (opts.guid) {
    const { data } = await db.from(TABLE).update(patch).eq("guid", opts.guid).select("guid");
    if (data && data.length) return;
  }
  if (opts.subscriptionId) {
    const { data } = await db
      .from(TABLE)
      .update(patch)
      .eq("stripe_subscription_id", opts.subscriptionId)
      .select("guid");
    if (data && data.length) return;
  }
  if (opts.email) {
    // Target the most recent row by id (PostgREST ignores order/limit on UPDATE,
    // and re-trials produce several rows under one email).
    const { data: rows } = await db
      .from(TABLE)
      .select("id")
      .eq("email", opts.email)
      .order("created_at", { ascending: false })
      .limit(1);
    const id = rows?.[0]?.id;
    if (id !== undefined && id !== null) {
      const { data } = await db.from(TABLE).update(patch).eq("id", id).select("guid");
      if (data && data.length) return;
    }
  }
  // No prior row (e.g. bought before ever trialing): create one.
  await db.from(TABLE).insert({ email: opts.email ?? null, guid: opts.guid ?? undefined, ...patch });
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig!,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (e) {
    return new Response(`bad signature: ${e instanceof Error ? e.message : e}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const sub = s.subscription
          ? await stripe.subscriptions.retrieve(String(s.subscription))
          : null;
        await grantPaid({
          guid: s.client_reference_id, // ← the app's guid, passed into the Payment Link
          email: s.customer_details?.email ?? s.customer_email,
          customerId: typeof s.customer === "string" ? s.customer : s.customer?.id,
          subscriptionId: sub?.id,
          periodEnd: sub?.current_period_end ?? Math.floor(Date.now() / 1000) + 31 * 86400,
        });
        break;
      }
      // Renewals: extend paid_through each billing cycle.
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        if (inv.subscription) {
          const sub = await stripe.subscriptions.retrieve(String(inv.subscription));
          await grantPaid({
            guid: sub.metadata?.guid, // stamped onto the subscription at checkout
            email: inv.customer_email,
            customerId: String(inv.customer),
            subscriptionId: sub.id,
            periodEnd: sub.current_period_end,
          });
        }
        break;
      }
      // Cancellation: leave paid_through as-is → the app's normal grace→lock
      // takes over at period end (non-destructive). Nothing to do here for now.
      case "customer.subscription.deleted":
        break;
    }
  } catch (e) {
    return new Response(`handler error: ${e instanceof Error ? e.message : e}`, { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), {
    headers: { "content-type": "application/json" },
  });
});
