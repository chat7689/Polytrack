// Stripe's webhook: when a checkout is paid, the player named in its
// client_reference_id gets their credits (grant_purchase, 100 000 per US
// dollar, once per checkout); a refund or a chargeback takes them back.
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
  // (trimmed: a secret pasted with a stray space or line break still works)
  const secret = (Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '').trim();
  if (!secret.startsWith('whsec_')) {
    // a 500, so Stripe keeps the payment and tries again once the secret is set
    console.error('STRIPE_WEBHOOK_SECRET is ' + (secret ? 'not a webhook signing secret (they start whsec_)' : 'not set') +
      '. Add it under Edge Functions > Secrets.');
    return new Response('Webhook secret not set up', { status: 500 });
  }
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, req.headers.get('Stripe-Signature') ?? '', secret, undefined, crypto);
  } catch (e) {
    console.error('Stripe signature check failed: the secret in STRIPE_WEBHOOK_SECRET is not this endpoint\'s signing secret ' +
      '(test and live endpoints each have their own). ' + (e instanceof Error ? e.message : ''));
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

  // a refund, or a chargeback (the card's owner disputes it with their bank):
  // the credits come back off, once
  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    const c = event.data.object as Stripe.Charge | Stripe.Dispute;
    const intent = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
    if (intent) {
      const { error } = await db.rpc('refund_purchase', { p_intent: intent });
      if (error) return new Response(error.message, { status: 500 });
    }
  }
  return new Response('ok', { status: 200 });
});
