// Bans, blocks and names, end to end: Coach's username check, banning a
// player with their computers / browsers / networks / other accounts,
// what a blocked computer can still do (nothing), evader alerts, bans that
// run out, undoing a ban, deleting an account, and the admin log.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const DEV = (k) => String(k).repeat(32).slice(0, 32);             // a computer id
await t.owner(`insert into public.settings (key, value) values ('invite', '{"code": "TESTCODE"}') on conflict (key) do update set value = excluded.value`);
// sign up the way the game does: a login, then claim_profile from a computer
async function signup(name, device, fp, ip) {
  const r = await t.owner('insert into auth.users (email) values ($1) returning id', [name.toLowerCase() + '@chat7689.github.io']);
  t.users[name] = r.rows[0].id;
  return (await t.one(name, 'select public.claim_profile($1, $2, $3, $4) as j', [name, 'TESTCODE', device, fp], { ip })).j;
}
const has = async (q, p) => (await t.owner(q, p)).rows.length > 0;
const profile = (name) => has('select 1 from public.profiles where display_name = $1', [name]);
const login = (name) => has('select 1 from auth.users where email = $1', [name.toLowerCase() + '@chat7689.github.io']);
// open hours don't matter here: a code for everyone
await t.owner("insert into public.access_codes (code, label, expires_at) values ('OPENOPEN', 'tests', now() + interval '1 day')");
const open = (name) => t.one(name, "select public.redeem_access('OPENOPEN') as j");
const run = (name, device, fp, ip) => t.one(name, "select public.start_run('s4c1', $1, $2, false) as j", [device, fp || 'fp'], { ip }).then((r) => r.j);
const runErr = (name, device, fp, ip) => t.err(name, "select public.start_run('s4c1', $1, $2, false)", [device, fp || 'fp'], { ip });

// ---------------------------------------------------------- Coach's name check
const bad = ['FuckBoy', 'f4ck_it', 'Shiiit', 'BigAss', 'sh1t_head', 'N1gga', 'Hitler99', 'kys_now', 'S3xy', 'xX_Slut_Xx', 'b1tch', 'Dick_Rider', 'Sex_Master', 'TitBot'];
const good = ['Classic', 'Passenger', 'Grasshopper', 'Assassin', 'Scunthorpe', 'Cocktail', 'Peacock', 'Hancock', 'Dickens', 'Raccoon', 'Torpedo',
  'Malon', 'Julian', 'Tobe', 'Bassist', 'Cassidy', 'Therapist', 'Shitake', 'Skyscraper', 'Vacuum', 'Document', 'Spice', 'Sussex', 'Grape',
  'Uranus', 'Compass', 'Speedy_Steve', 'Turbo_Kid', 'NightRider'];
for (const n of bad) ok((await t.owner('select public._bad_name($1) as w', [n])).rows[0].w, 'Coach catches ' + n);
for (const n of good) { const w = (await t.owner('select public._bad_name($1) as w', [n])).rows[0].w; ok(!w, 'Coach lets ' + n + ' through' + (w ? ' (flagged ' + w + ')' : '')); }
const nc = (await t.one(null, "select public.name_check('FuckBoy') as j")).j;
ok(nc.ok === false && nc.word === 'f***', 'the sign-up page can ask before making the login, and sees the word masked: ' + JSON.stringify(nc));
const bn = await signup('Shiiit', DEV(9), 'fp9', '9.9.9.9');
ok(bn.error === 'badname' && !(await profile('Shiiit')) && !(await login('Shiiit')), 'a bad name is refused at sign-up too, and its login is removed');

// ----------------------------------------------------------- the ban itself
const A = 'Alpha', D1 = DEV(1), F1 = 'fingerprint-one', IP1 = '1.1.1.1';
ok((await signup(A, D1, F1, IP1)).ok, 'a player signs up on computer 1');
await t.one(A, 'select public.touch_device($1, $2) as j', [D1, F1], { ip: IP1 });
await open(A);
ok((await run(A, D1, F1, IP1)).ok, 'and can drive');
// someone else has used computer 1 too (a shared school computer)
await t.mkUser('Charlie');
await t.one('Charlie', 'select public.touch_device($1, $2) as j', [D1, F1], { ip: IP1 });
await open('Charlie');
const uA = t.users[A];
const r1 = (await t.admin('select public.admin_ban_player($1, $2, 0, true, false, false, false) as j', [uA, 'cheating'])).rows[0].j;
ok(r1.devices === 1, 'banning with their computers blocks the 1 computer they used ' + JSON.stringify(r1));
ok(/suspended/.test(await runErr(A, D1, F1, IP1)), 'the banned player can do nothing at all');
ok(/suspended/.test(await runErr(A, DEV(8), 'other', '8.8.8.8')), 'not even from another computer');
ok((await run('Charlie', D1, F1, IP1)).error === 'blocked', 'another account on the blocked computer can\'t set times there');
ok((await t.one('Charlie', 'select public.touch_device($1, $2) as j', [D1, F1], { ip: IP1 })).j.blocked === true, 'and the game is told the computer is blocked (it locks the screen)');
ok((await run('Charlie', DEV(7), 'fp7', '7.7.7.7')).ok, 'that other account still plays from its own computer (their accounts weren\'t banned)');
const st = (await t.one(null, 'select public.device_status($1, $2) as j', [D1, F1], { ip: IP1 })).j;
ok(st.blocked === true && st.until === null, 'before anyone signs in, the computer is known to be blocked for good: ' + JSON.stringify(st));
ok((await t.one(null, 'select public.device_status($1, $2) as j', [DEV(6), 'fp6'], { ip: '6.6.6.6' })).j.blocked === false, 'other computers are fine');
const r2 = await signup('Bravo', D1, F1, IP1);
ok(r2.error === 'blocked' && !(await profile('Bravo')) && !(await login('Bravo')), 'no new account can be made on the blocked computer: ' + JSON.stringify(r2));
// clearing the browser gives a new computer id, but the same fingerprint and network
const r3 = await signup('Echo', DEV(2), F1, IP1);
ok(r3.ok, 'a cleared browser (new id) can still sign up when only the computer was blocked');
const ev = (await t.admin('select public.admin_evaders() as j')).rows[0].j;
ok(ev.some((e) => e.name === 'Echo' && /fingerprint/.test(e.flag)), 'but the admin is told: same browser fingerprint as a blocked computer ' + JSON.stringify(ev));
const links = (await t.admin('select public.admin_player_links($1) as j', [uA])).rows[0].j;
ok(links.devices.length === 1 && links.devices[0].blocked && links.alts.some((x) => x.name === 'Charlie') && links.ban.reason === 'cheating',
  'the admin sees the player\'s computer (blocked), the other accounts on it and the reason ' + JSON.stringify(links.alts));

// a harder ban: fingerprints and the other accounts too, for a week
const r4 = (await t.admin('select public.admin_ban_player($1, $2, 7, true, true, false, true) as j', [uA, 'cheating again'])).rows[0].j;
ok(r4.fps === 1 && r4.alts === 1, 'with fingerprints and other accounts: 1 fingerprint, 1 other account ' + JSON.stringify(r4));
ok(/suspended/.test(await runErr('Charlie', DEV(7), 'fp7', '7.7.7.7')), 'the other account on that computer is banned now too');
ok((await signup('Foxtrot', DEV(3), F1, '3.3.3.3')).error === 'blocked', 'and a cleared browser with the same fingerprint can\'t sign up');
const myBan = (await t.as('Charlie', 'select reason, until from public.account_bans')).rows;
ok(myBan.length === 1 && /Same computer as Alpha/.test(myBan[0].reason) && myBan[0].until, 'a banned player can read why, and until when (and only their own) ' + JSON.stringify(myBan));

// bans run out by themselves
await t.owner("update public.account_bans set until = now() - interval '1 minute' where uid = $1", [t.users.Charlie]);
await t.owner("update public.bans set until = now() - interval '1 minute' where from_uid = $1", [uA]);
ok((await run('Charlie', DEV(7), 'fp7', '7.7.7.7')).ok, 'once a ban has run out, the player plays again');
await t.one('Charlie', 'select public.touch_device($1, $2) as j', [DEV(7), 'fp7'], { ip: '7.7.7.7' });
ok(!(await has('select 1 from public.profiles where display_name = $1 and banned', ['Charlie'])), 'and signing in clears the ban for good');
ok((await t.one(null, 'select public.device_status($1, $2) as j', [D1, F1], { ip: IP1 })).j.blocked === false, 'blocks that have run out no longer count');

// undo everything a ban did
await t.admin('select public.admin_ban_player($1, $2, 0, true, true, true, true)', [uA, 'for good']);
ok((await t.one(null, 'select public.device_status($1, $2) as j', [DEV(5), 'x'], { ip: IP1 })).j.blocked === true, 'a network block stops a new computer on that network too');
await t.admin('select public.admin_unban_player($1, true)', [uA]);
ok((await run(A, D1, F1, IP1)).ok && (await signup('Golf', DEV(4), 'fresh', IP1)).ok, 'unban everything: the player, their computer and their network are all free again');
ok(!(await has('select 1 from public.bans where from_uid = $1', [uA])), 'with every block the ban made gone');

// delete an account, then keep its computer out for good
await t.admin('select public.admin_ban_player($1, $2, 0, true, false, false, false)', [t.users.Golf, 'deleted for bad behaviour']);
await t.admin('select public.admin_delete_player($1)', [t.users.Golf]);
ok(!(await profile('Golf')) && !(await login('Golf')), 'deleting an account removes the player and their login');
ok((await signup('Hotel', DEV(4), 'fresh', '4.4.4.4')).error === 'blocked', 'and the computer it was on still can\'t make accounts');

// a player whose account is fine but whose computer is blocked (by hand,
// or by somebody else's ban): the admin sees it and can unblock them
ok((await signup('Mike', DEV('c'), 'fp-mike', '12.0.0.1')).ok, 'a player signs up');
await open('Mike');
await t.admin("select public.admin_ban('device', $1, 'by hand')", [DEV('c')]);
await t.admin("select public.admin_ban('fp', 'fp-mike', 'by hand')");
ok((await run('Mike', DEV('c'), 'fp-mike', '12.0.0.1')).error === 'blocked', 'their computer is blocked, so their times don\'t count');
const bl = (await t.admin('select public.admin_blocked_players() as j')).rows[0].j;
const mine = bl.find((x) => x.uid === t.users.Mike);
ok(mine && mine.kinds.includes('device') && mine.kinds.includes('fp'), 'the admin\'s player list knows they are blocked, and how: ' + JSON.stringify(mine));
ok(t.users.Charlie && !bl.some((x) => x.uid === t.users.Charlie), 'players who aren\'t blocked aren\'t listed');
ok((await t.admin('select public.admin_unblock_player($1) as n', [t.users.Mike])).rows[0].n === 2, 'Unblock lifts both blocks on their computer');
ok((await run('Mike', DEV('c'), 'fp-mike', '12.0.0.1')).ok, 'and their times count again');
ok(!(await t.admin('select public.admin_blocked_players() as j')).rows[0].j.some((x) => x.uid === t.users.Mike), 'and they are off the blocked list');
// unban everything also lifts blocks on their own computer that another ban made
await t.admin("select public.admin_ban('device', $1, 'by hand again')", [DEV('c')]);
await t.admin('select public.admin_set_banned($1, true)', [t.users.Mike]);
await t.admin('select public.admin_unban_player($1, true)', [t.users.Mike]);
ok((await run('Mike', DEV('c'), 'fp-mike', '12.0.0.1')).ok, 'Unban with "everything" frees their computer too, whoever blocked it');
ok(/admin/i.test(await t.err('Mike', 'select public.admin_unblock_player($1)', [t.users.Mike])), 'players can\'t unblock themselves');
ok(/permission denied/.test(await t.err('Mike', 'select * from public._player_keys($1)', [t.users.Mike])), 'nor list anyone\'s computers');

// the security feed: what blocked computers tried, and look-alikes
const evs = (await t.admin('select public.admin_security_events(100) as j')).rows[0].j;
const kinds = new Set(evs.map((e) => e.kind));
ok(['bad name', 'blocked sign-up', 'blocked sign-in'].every((k) => kinds.has(k)), 'the feed has the refused name, the blocked sign-ups and sign-ins: ' + [...kinds].join(', '));
ok(evs.some((e) => e.kind === 'blocked sign-up' && e.name === 'Hotel' && e.device === DEV(4)), 'naming the computer and the name it tried');
await t.mkUser('India');
await t.admin('select public.admin_ban_player($1, $2, 0, true, false, false, false)', [t.users.Echo, 'look-alike test']);
await t.one('India', 'select public.touch_device($1, $2) as j', [DEV('a'), F1], { ip: '10.0.0.1' });
ok((await t.admin('select public.admin_security_events(100) as j')).rows[0].j.some((e) => e.kind === 'look-alike' && e.name === 'India'),
  'a brand-new computer id with a blocked computer\'s fingerprint is flagged as a look-alike');
const before = (await t.admin('select public.admin_security_events(500) as j')).rows[0].j.length;
for (let k = 0; k < 3; k++) await t.one(null, 'select public.claim_profile($1, $2, $3, $4) as j', ['x', 'x', DEV(4), 'fresh']).catch(() => null);
await signup('Juliet', DEV(4), 'fresh', '4.4.4.4'); await signup('Juliet2', DEV(4), 'fresh', '4.4.4.4');
ok((await t.admin('select public.admin_security_events(500) as j')).rows[0].j.length - before === 2, 'one line per computer and name an hour, so the feed can\'t be flooded');

// lockdown: no new accounts at all for a while
await t.admin('select public.admin_set_signups(false)');
ok((await t.one(null, 'select public.device_status($1, $2) as j', [DEV('b'), 'fpb'], { ip: '11.0.0.1' })).j.signupsPaused === true, 'the game can tell sign-ups are paused');
ok((await signup('Kilo', DEV('b'), 'fpb', '11.0.0.1')).error === 'paused' && !(await login('Kilo')), 'and new accounts are refused while they are');
await t.admin('select public.admin_set_signups(true)');
ok((await signup('Lima', DEV('b'), 'fpb', '11.0.0.1')).ok, 'reopening lets them in again');

// only the admin
ok(/admin/i.test(await t.err('India', 'select public.admin_security_events(10)')), 'players can\'t read the security feed');
ok(/admin/i.test(await t.err(null, 'select public.admin_set_signups(false)')), 'nor pause sign-ups');
ok(/admin/i.test(await t.err('India', "select public.admin_ban_player($1, 'x', 0, true, true, true, true)", [uA])), 'players can\'t ban anyone');
ok(/admin/i.test(await t.err(null, "select public.admin_ban_player($1, 'x', 0, true, true, true, true)", [uA])), 'nor can anyone without the admin login');
ok((await t.as('India', 'select * from public.admin_log')).rows.length === 0 && (await t.as('India', 'select * from public.account_bans')).rows.length === 0,
  'players can\'t read the admin log or other people\'s bans');
ok(/permission denied/.test(await t.err('India', "select public._log('x', 'y', 'z')")), 'nor write to the log');
const log = (await t.admin('select public.admin_actions(50) as j')).rows[0].j;
ok(['ban', 'unban', 'delete account'].every((a) => log.some((e) => e.action === a)), 'the admin log has the bans, unbans and the deletion: ' + log.map((e) => e.action).join(', '));

// track names
await open('India');
const tr = (await t.one('India', `select public.save_track(null, 'Fuck Road', true, 15, '[["S", 80, 15]]'::jsonb) as j`)).j;
ok(!tr.ok && /Coach detected/.test(tr.error), 'Coach checks track names too: ' + tr.error);
ok((await t.one('India', `select public.save_track(null, 'Grasshopper Gap', true, 15, '[["S", 80, 15]]'::jsonb) as j`)).j.ok, 'and lets ordinary ones through');
done();
