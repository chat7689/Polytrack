// Account safety: internal helpers (public._*) are never callable from the
// game or the API, so nobody can move another player's profile, credits or
// items by calling one straight. (Nov 2026: _adopt was callable by any
// signed-in player.)
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();

// every internal helper is closed to players and to anon
const open = (await t.owner(`
  select p.proname as name, r.role
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(role)
  where n.nspname = 'public' and p.proname like '\\_%'
    and has_function_privilege(r.role, p.oid, 'execute')
  order by 1`)).rows;
ok(open.length === 0, 'no public._* helper is executable by anon or players: ' + open.map((r) => r.name + '/' + r.role).join(', '));

// the attack: a signed-in player with no profile of their own calls _adopt
// to take another player's profile (name, credits, times)
await t.mkUser('Victim');
const V = t.users.Victim;
await t.owner("insert into public.credit_events (uid, delta, kind) values ($1, 5000, 'test')", [V]);
const T = (await t.owner("insert into auth.users (email) values ('thief@chat7689.github.io') returning id")).rows[0].id;
t.users.Thief = T;
const e1 = await t.err('Thief', 'select public._adopt($1, $2, $3)', [V, T, 'Victim']);
ok(e1 && /permission denied/.test(e1), 'a player cannot call _adopt: ' + e1);
const still = (await t.owner('select id from public.profiles where display_name = $1', ['Victim'])).rows[0];
ok(still && still.id === V, 'the victim keeps their profile');
ok((await t.one('Victim', 'select public.my_balance() as j')).j === 5000, 'and their credits');

// other helpers that act on a given player id
for (const [sql, args] of [
  ['select public._auction_give($1, $2)', [T, 'x']],
  ['select public._balance($1)', [V]],
  ['select public._may_play($1)', [V]],
  ['select public._podium_maps($1)', [V]],
  ['select public._track_limit($1)', [V]],
]) {
  const e = await t.err('Thief', sql, args);
  ok(e && /permission denied/.test(e), sql + ' is refused: ' + e);
}

// the normal ways in still work: a legacy profile is adopted through claim_profile
await t.owner("insert into public.profiles (id, display_name, legacy) values (gen_random_uuid(), 'Oldie', true)");
const O = (await t.owner("insert into auth.users (email) values ('oldie@chat7689.github.io') returning id")).rows[0].id;
t.users.Oldie = O;
const c = (await t.one('Oldie', "select public.claim_profile('Oldie', '', $1, 'fp') as j", ['a'.repeat(32)])).j;
ok(c.ok && c.adopted, 'a returning player still gets their old profile: ' + JSON.stringify(c));
ok((await t.owner('select id from public.profiles where display_name = $1', ['Oldie'])).rows[0].id === O, 'under their new login');
// and the admin page still works
ok((await t.admin('select public.is_admin() as a')).rows[0].a === true, 'the admin token still works');
done();
