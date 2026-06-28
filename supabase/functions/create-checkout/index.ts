// Lighthouse create-checkout (Supabase Edge Function, Deno).
//
// Creates a Stripe Checkout Session for the $14.99/mo subscription and returns
// its URL. The desktop calls this (public, anon-key) with the install's guid +
// the buyer's email; on payment the stripe-webhook upgrades that guid's row to
// paid, and the app polls itself unlocked — no license key changes hands.
//
// Secrets (supabase secrets set ...):
//   STRIPE_SECRET_KEY      sk_live_… / sk_test_…
//   STRIPE_PRICE_ID        recurring $14.99/mo price (defaults to the one below)
//   CHECKOUT_RETURN_URL    where Stripe sends the buyer after paying/cancelling
import Stripe from "https://esm.sh/stripe@17?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-12-18.acacia" });
const PRICE_ID = Deno.env.get("STRIPE_PRICE_ID") ?? "price_1TnCuIL2wCfpRYgJ6bjtojHo";
const RETURN_URL = Deno.env.get("CHECKOUT_RETURN_URL") ?? "https://github.com/lmansf/lighthouse";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const guid = body.guid ? String(body.guid) : undefined;
  const email = body.email ? String(body.email) : undefined;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      // Ties the purchase to this install (webhook upgrades exactly this guid)
      // and to the buyer's email (so a business can buy many under one card).
      client_reference_id: guid,
      customer_email: email,
      subscription_data: guid ? { metadata: { guid } } : undefined,
      success_url: `${RETURN_URL}?checkout=success`,
      cancel_url: `${RETURN_URL}?checkout=cancelled`,
      allow_promotion_codes: true,
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "stripe error" }, 502);
  }
});
