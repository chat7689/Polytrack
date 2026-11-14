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
const fb = async () => (await t.owner('select coalesce((select free_boxes from public.garage where uid = $1), 0) as n', [t.users.Buyer])).rows[0].n;
ok(g1.ok && g1.credits === 30000 && g1.boxes === 3 && (await bal('Buyer')) === b0 + 30000 && (await fb()) === 3, '$1 buys 30 000 credits and 3 boxes ' + JSON.stringify(g1));
const g2 = await grant('cs_test_1', t.users.Buyer, 100, 'usd', 'pi_1');
ok(g2.duplicate && (await bal('Buyer')) === b0 + 30000 && (await fb()) === 3, 'the same checkout told twice (Stripe retries) pays once');
const g3 = await grant('cs_test_2', t.users.Buyer, 300, 'usd', 'pi_2');
ok(g3.credits === 90000 && g3.boxes === 9, '$3 (three of them) buys 90 000 and 9 boxes');
const g6 = await grant('cs_test_5', t.users.Buyer, 500, 'usd', 'pi_5');
ok(g6.credits === 180000 && g6.boxes === 18 && (await fb()) === 30, 'the $5 pack is 180 000 and 18 boxes (one pack free) ' + JSON.stringify(g6));
const g4 = await grant('cs_test_3', 'not-a-player', 100, 'usd', 'pi_3');
ok(g4.ok && g4.credits === 0 && g4.matched === false, 'a checkout naming nobody pays nobody, but is recorded for the admin');
const g5 = await grant('cs_test_4', t.users.Buyer, 100, 'eur', 'pi_4');
ok(g5.credits === 0, 'only US dollars count');
ok((await t.admin('select public.admin_purchases(50) as j')).rows[0].j.length === 5, 'the admin sees every purchase');

// refunds
const before = await bal('Buyer');
const r1 = (await svc('select public.refund_purchase($1) as j', ['pi_2'])).rows[0].j;
ok(r1.found && (await bal('Buyer')) === before - 90000 && (await fb()) === 21, 'a refund takes the credits and the boxes back');
ok(!(await svc('select public.refund_purchase($1) as j', ['pi_2'])).rows[0].j.found && (await bal('Buyer')) === before - 90000, 'and only once');
await t.owner('update public.garage set free_boxes = 5 where uid = $1', [t.users.Buyer]);
await svc('select public.refund_purchase($1) as j', ['pi_5']);
ok((await fb()) === 0, 'boxes already opened can\'t come back: it takes what is left, never below 0');

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
// the daily spending limit
const st = async () => (await t.one('Buyer', 'select public.shop_links() as l')).l;
let s = await st();
ok(s.limit === 20, 'a $20 a day limit unless the admin changes it ' + JSON.stringify(s));
ok(Number(s.spent) === 1, 'today counts what was paid and not refunded (the $1; the $3 and $5 were refunded, euros are left out) ' + s.spent);
await t.admin('select public.admin_set_shop_limit(10)');
ok((await st()).limit === 10, 'the admin sets the limit');
await t.admin('select public.admin_set_shop_limit(0)');
ok((await st()).limit === 0, 'and 0 turns it off');
ok(/0 \(none\) to 1000/.test((await t.admin('select public.admin_set_shop_limit(-5)').catch((e) => e)).message || ''), 'no negative limits');
ok(/admin/i.test(await t.err('Buyer', 'select public.admin_set_shop_limit(1000)')), 'only the admin sets it');
ok(Number((await t.one(null, 'select public.shop_links() as l')).l.spent) === 0, 'signed out: nothing spent');
// --- the thank-you levels: one driver level a dollar, told only afterwards, taken back by a refund
await t.mkUser('Gifty');
const xpOf = async (n) => Number((await t.owner('select coalesce((select xp from public.garage where uid = $1), 0) as x', [t.users[n]])).rows[0].x);
const lvOf = async (n) => Number((await t.owner('select public._level($1) as l', [await xpOf(n)])).rows[0].l);
await t.owner('insert into public.garage (uid, xp) values ($1, 150) on conflict (uid) do update set xp = 150', [t.users.Gifty]);
ok((await lvOf('Gifty')) === 2, 'level 2 with 150 XP');
const gg = await grant('cs_gift_1', t.users.Gifty, 300, 'usd', 'pi_gift_1');
ok(gg.levels === 3 && (await lvOf('Gifty')) === 5 && (await xpOf('Gifty')) === 1000 + 50, '$3: 3 levels, and the 50 XP into level 2 carries over ' + (await xpOf('Gifty')));
const ge = (await t.owner("select note from public.credit_events where uid = $1 and kind = 'gift_levels'", [t.users.Gifty])).rows;
ok(ge.length === 1 && ge[0].note === '3' && (await bal('Gifty')) === 90000, 'the game hears of it (a gift_levels line), and the credits are as before');
await grant('cs_gift_1', t.users.Gifty, 300, 'usd', 'pi_gift_1');
ok((await lvOf('Gifty')) === 5, 'a repeated webhook gives no more levels');
await grant('cs_gift_2', t.users.Gifty, 500, 'usd', 'pi_gift_2');
ok((await lvOf('Gifty')) === 10, '$5: 5 levels more');
await svc('select public.refund_purchase($1)', ['pi_gift_2']);
ok((await lvOf('Gifty')) === 5 && (await xpOf('Gifty')) === 1050, 'a refund takes those levels back');
const g99 = await grant('cs_gift_3', t.users.Gifty, 50, 'usd', 'pi_gift_3');
ok(!g99.levels && (await lvOf('Gifty')) === 5, 'under a dollar: nothing');
done();
