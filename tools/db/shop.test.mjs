// Buying credits with Stripe: what the webhook (the service role) pays out,
// that a checkout pays out once, refunds, a checkout naming nobody, and that
// no player can pay themselves.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const svc = (sql, params) => t.db.transaction(async (tx) => { await tx.exec('set local role service_role'); return tx.query(sql, params || []); });
const bal = async (name) => Number((await t.owner('select public._balance($1) as b', [t.users[name]])).rows[0].b);
const grant = async (session, uid, cents, cur, intent) =>
  (await svc('select public.grant_purchase($1, $2, $3, $4, $5) as j', [session, uid, cents, cur, intent])).rows[0].j;

await t.mkUser('Buyer');
const b0 = await bal('Buyer');
const g1 = await grant('cs_test_1', t.users.Buyer, 100, 'usd', 'pi_1');
ok(g1.ok && g1.credits === 100000 && (await bal('Buyer')) === b0 + 100000, '$1 buys 100 000 credits ' + JSON.stringify(g1));
const g2 = await grant('cs_test_1', t.users.Buyer, 100, 'usd', 'pi_1');
ok(g2.duplicate && (await bal('Buyer')) === b0 + 100000, 'the same checkout told twice (Stripe retries) pays once');
const g3 = await grant('cs_test_2', t.users.Buyer, 300, 'usd', 'pi_2');
ok(g3.credits === 300000, '$3 (three of them) buys 300 000');
const g6 = await grant('cs_test_5', t.users.Buyer, 500, 'usd', 'pi_5');
ok(g6.credits === 600000, 'the $5 pack is 600 000 (one pack free) ' + JSON.stringify(g6));
const g4 = await grant('cs_test_3', 'not-a-player', 100, 'usd', 'pi_3');
ok(g4.ok && g4.credits === 0 && g4.matched === false, 'a checkout naming nobody pays nobody, but is recorded for the admin');
const g5 = await grant('cs_test_4', t.users.Buyer, 100, 'eur', 'pi_4');
ok(g5.credits === 0, 'only US dollars count');
ok((await t.admin('select public.admin_purchases(50) as j')).rows[0].j.length === 5, 'the admin sees every purchase');

// refunds
const before = await bal('Buyer');
const r1 = (await svc('select public.refund_purchase($1) as j', ['pi_2'])).rows[0].j;
ok(r1.found && (await bal('Buyer')) === before - 300000, 'a refund takes the credits back');
ok(!(await svc('select public.refund_purchase($1) as j', ['pi_2'])).rows[0].j.found && (await bal('Buyer')) === before - 300000, 'and only once');

// nobody else can pay out
ok(/permission denied/.test(await t.err('Buyer', "select public.grant_purchase('cs_x', auth.uid()::text, 100000, 'usd', 'pi_x')")), 'a player can\'t give themselves credits');
ok(/permission denied/.test(await t.err(null, "select public.grant_purchase('cs_x', 'x', 100000, 'usd', 'pi_x')")), 'nor can anyone without signing in');
ok(/permission denied/.test(await t.err('Buyer', "select public.refund_purchase('pi_1')")), 'nor take back someone else\'s');
ok(/permission denied|row-level security/.test(await t.err('Buyer', "insert into public.purchases (session_id, uid, credits, amount_cents, currency) values ('cs_y', auth.uid(), 1, 1, 'usd')")), 'nor write a purchase');
ok((await t.as('Buyer', 'select * from public.purchases')).rows.every((r) => r.uid === t.users.Buyer), 'a player sees only their own purchases');

// the shop link
ok((await t.one('Buyer', 'select public.shop_link() as l')).l === '', 'no link: the shop is off');
await t.admin("select public.admin_set_shop('https://buy.stripe.com/test_abc123')");
ok((await t.one('Buyer', 'select public.shop_link() as l')).l === 'https://buy.stripe.com/test_abc123', 'the admin pastes a Payment Link and everyone gets it');
ok(/Payment Link/.test((await t.admin("select public.admin_set_shop('https://evil.example.com/pay')").catch((e) => e)).message || ''), 'only a Stripe Payment Link is accepted');
ok(/admin/i.test(await t.err('Buyer', "select public.admin_set_shop('https://buy.stripe.com/x')")), 'and only by the admin');
await t.admin("select public.admin_set_shop_links('https://buy.stripe.com/one1', 'https://buy.stripe.com/five5')");
const links = (await t.one('Buyer', 'select public.shop_links() as l')).l;
ok(links.one === 'https://buy.stripe.com/one1' && links.five === 'https://buy.stripe.com/five5', 'the links of both packs reach the game ' + JSON.stringify(links));
await t.admin("select public.admin_set_shop('https://buy.stripe.com/one2')");
ok((await t.one('Buyer', 'select public.shop_links() as l')).l.five === 'https://buy.stripe.com/five5', 'changing the $1 link keeps the $5 one');
ok(/different/.test((await t.admin("select public.admin_set_shop_links('https://buy.stripe.com/same', 'https://buy.stripe.com/same')").catch((e) => e)).message || ''), 'the two packs need different links');
ok(/admin/i.test(await t.err('Buyer', "select public.admin_set_shop_links('https://buy.stripe.com/a', '')")), 'only the admin sets them');
done();
