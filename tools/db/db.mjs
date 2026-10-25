// A test database: supabase/schema.sql (run twice, as the user re-runs it)
// on PGlite with tools/db/shim.sql. `as(name, sql)` runs as a signed-in
// player, `admin(sql)` as the admin page (with a valid admin token),
// `owner(sql)` as the database owner (the SQL editor).
// Needs @electric-sql/pglite: `npm i @electric-sql/pglite` in this folder.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'fs';
const here = new URL('.', import.meta.url);
const ROOT = new URL('../../', here);

export async function makeDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(fs.readFileSync(new URL('shim.sql', here), 'utf8'));
  const schema = fs.readFileSync(new URL('supabase/schema.sql', ROOT), 'utf8');
  await db.exec(schema);
  await db.exec(schema);
  const users = {};
  const owner = (sql, p) => db.query(sql, p || []);
  async function mkUser(name) {
    const r = await db.query('insert into auth.users (email) values ($1) returning id', [name.toLowerCase() + '@chat7689.github.io']);
    users[name] = r.rows[0].id;
    await db.query('insert into public.profiles (id, display_name) values ($1, $2) on conflict do nothing', [users[name], name]);
    return users[name];
  }
  async function as(name, sql, params = [], hdr = {}) {
    return db.transaction(async (tx) => {
      const h = { 'x-forwarded-for': hdr.ip || '10.0.0.1' };
      if (hdr.token) h['x-admin-token'] = hdr.token;
      await tx.query("select set_config('request.headers', $1, true)", [JSON.stringify(h)]);
      if (name) {
        const claims = JSON.stringify({ sub: users[name], email: name.toLowerCase() + '@chat7689.github.io', role: 'authenticated' });
        await tx.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [claims, users[name]]);
        await tx.exec('set local role authenticated');
      } else await tx.exec('set local role anon');
      return tx.query(sql, params);
    });
  }
  // an admin session token, made the way admin_login makes one
  let token = null;
  async function adminToken() {
    if (token) return token;
    await owner("select public.admin_set_login('testadmin', 'test only password 1')");
    const r = await as(null, "select public.admin_login('testadmin', 'test only password 1') as j");
    const j = r.rows[0].j;
    token = typeof j === 'string' ? j : j.token;
    return token;
  }
  const admin = async (sql, params) => as(null, sql, params, { token: await adminToken() });
  const one = async (name, sql, params, hdr) => (await as(name, sql, params, hdr)).rows[0];
  const err = async (name, sql, params, hdr) => { try { await as(name, sql, params, hdr); return null; } catch (e) { return e.message; } };
  return { db, owner, as, admin, one, err, mkUser, users };
}

let fails = 0, passes = 0;
export const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log('FAIL:', msg); } };
export const done = () => { console.log(passes + ' passed, ' + fails + ' failed'); process.exit(fails ? 1 : 0); };
