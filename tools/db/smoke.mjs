import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
await t.mkUser('Kid1');
ok((await t.one('Kid1', 'select public.my_balance() as b')).b === 0, 'a player has a balance');
ok((await t.admin('select public.is_admin() as a')).rows[0].a === true, 'the admin token works');
done();
