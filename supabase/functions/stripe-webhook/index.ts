// Stripe's webhook: when a checkout is paid, the player named in its
// client_reference_id gets their credits (grant_purchase, 100 000 per US
// dollar, once per checkout); a refunded payment takes them back.
//
// One secret (Supabase: Edge Functions, Secrets): STRIPE_WEBHOOK_SECRET, the
// webhook's signing secret. It never calls Stripe, only checks Stripe's
// signature, so no Stripe API key is needed. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself. Deploy with JWT
// verification off (Stripe signs its requests instead): see supabase/SETUP.md.
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const stripe = new Stripe('sk_unused', {          // (only used to check signatures)
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient()
});
const crypto = Stripe.createSubtleCryptoProvider();
const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false }
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, req.headers.get('Stripe-Signature') ?? '',
      Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '', undefined, crypto);
  } catch (_e) {
    return new Response('Bad signature', { status: 400 });
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status !== 'paid') return new Response('Not paid yet', { status: 200 });
    const { data, error } = await db.rpc('grant_purchase', {
      p_session: s.id,
      p_uid: s.client_reference_id ?? '',
      p_amount: s.amount_total ?? 0,
      p_currency: s.currency ?? '',
      p_intent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null
    });
    // an error makes Stripe try again later; grant_purchase pays a checkout only once
    if (error) return new Response(error.message, { status: 500 });
    return Response.json(data);
  }

  if (event.type === 'charge.refunded') {
    const c = event.data.object as Stripe.Charge;
    const intent = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
    if (intent) {
      const { error } = await db.rpc('refund_purchase', { p_intent: intent });
      if (error) return new Response(error.message, { status: 500 });
    }
  }
  return new Response('ok', { status: 200 });
});
