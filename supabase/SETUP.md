# Moving aiPolytrack from Firebase to Supabase

About 15 minutes. Do it at a quiet time: from step 5 until the import in
step 8, the live game runs on Supabase with empty leaderboards.

Supabase project: `https://tkjiivodmmjeruhxspcz.supabase.co` (already in
`index.html` and `admin.html`, with the publishable key).

## 1. Save everything from Firebase

Push `main` so the live admin page has the export button:

```
cd C:\Users\malon\skyframe
git checkout main
git push origin main
```

Wait a minute for GitHub Pages, then open the live `admin.html`. Go to
**Settings**, click **Export all data**, and keep the file
(`aipolytrack-export-YYYY-MM-DD.json`). Runs played after this moment don't
come across, so do it right before switching.

The export reads every record once. If it fails with a quota message, the
day's Firebase reads are used up. Try again after midnight Pacific time,
when they reset.

## 2. Create the database

In Supabase, open **SQL Editor** and click **New query**. Paste the whole of
`supabase/schema.sql` and click **Run**. It should end with
"Success. No rows returned". Running it again later (after an update) is
safe.

## 3. Turn off email confirmation

Go to **Authentication → Sign In / Providers → Email**. Turn **Confirm
email** off and save. Leave "Enable email provider" and "Allow new users to
sign up" on.

Player logins have no real inbox, so with confirmation on nobody could ever
finish signing up.

## 4. Set the invite code

In the SQL Editor, run this with your code (the old one is fine):

```sql
insert into public.settings (key, value) values ('invite', '{"code":"YOUR-CODE-HERE"}')
on conflict (key) do update set value = excluded.value;
```

## 5. Switch the live game over

```
cd C:\Users\malon\skyframe
git checkout main
git merge supabase
git push origin main
```

## 6. Make your account

Wait a minute, then open the game and click **Create an account**. Use
your usual username, any password, and the invite code.

## 7. The admin login

Nothing to set up. `admin.html` has its own fixed login (username
`tobe`), checked inside the database by `admin_login` in schema.sql
against a bcrypt hash of the password. It is the only way in: game
accounts are never admins, and ten wrong tries lock the login for 15
minutes. A sign-in lasts 12 hours on that device, or until **Sign out**.

## 8. Bring the Firebase data in

Open `admin.html` and sign in with the admin login.
Go to **Settings → Bring in the Firebase data**, pick the file from step 1,
and click **Import**. It takes a few seconds per few thousand records.

- Pressing Import again is safe. Nothing is doubled, and a faster time is
  never replaced by a slower one. Trophies you've changed since, and
  players you've deleted, stay as you left them.
- Your own account from step 6 is matched to your old Firebase account by
  username, so your old times, credits and trophies land on it.
- The old admin passcode (for deleting accounts) comes across with the
  import.

## 9. Tell the players

> The game moved servers. Click **Create an account** and use your **same
> username**, with any password and no invite code. Your times, credits,
> colours and trophies come back with it.

Anyone who tries **Sign in** with their old password is told this
automatically. Until a player comes back, the admin page lists them as
"not back yet", and their times still show on the leaderboards.

## 10. Afterwards

- **Rotate the secret key.** It was pasted into a chat. Go to
  **Project Settings → API Keys**, then create a new secret key and delete
  the old one. The game never uses it; it only uses the publishable key.
- **Download a backup now and then** (admin page → Settings). The free plan
  keeps no backups you can download.
- **Inactive projects are paused.** A free project with no activity for a
  week gets paused; it restarts from the Supabase dashboard.
- **Forgotten passwords.** Players → **Password** sets a new one for them.
- Firebase can stay as it is. Nothing uses it any more.

## What runs where

| | |
|---|---|
| `supabase/schema.sql` | The database: tables, security rules and server functions. All the checks live here: invite codes, best times only getting faster, credit balances and the admin login. |
| `index.html` → `Cloud` | Sign-in, live leaderboards, credits, ghosts and colours, through supabase-js. |
| `admin.html` | The admin panel. It signs in with the admin login, never as a player. Settings → Messages sets the boxes on the game's menu and sign-in screen. |
