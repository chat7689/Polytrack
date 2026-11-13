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

There is exactly one admin login, and you set it yourself so its password
never passes through anyone else. In **SQL Editor**, run (with your own
username and a password of 12 or more characters):

    select public.admin_set_login('your-username', 'your password');

That removes every other admin login and signs out every admin session.
Run it again any time to change the login. Only a bcrypt hash of the
password is stored; no player, browser or admin page can call it. Then
delete that query from the SQL Editor's history so the password isn't
left there.

Game accounts are never admins. Ten wrong tries from one network lock that
network out of the admin login for 15 minutes (you can still sign in from
anywhere else). A sign-in lasts 12 hours on that device, or until
**Sign out**.

### Human check on sign-up and sign-in (optional, recommended)

1. At dash.cloudflare.com, open **Turnstile**, **Add widget**, add the
   game's web address, and copy the **site key** and **secret key**.
2. In `admin.html`, **Settings**, **Human check**: paste the site key and
   save.
3. In Supabase: **Authentication**, **Attack Protection**, **Enable
   CAPTCHA protection**, provider Turnstile, paste the secret key, save.

Do 2 before 3: with CAPTCHA on in Supabase but no site key in the game,
nobody can sign in. To switch it off, do 3 first, then clear the key.

### The map rules

The server knows where every map starts and finishes, its checkpoints and
the fastest time it will believe (`course_rules` in schema.sql, daily maps
included through 2027-12-31). When a map's layout changes, its rules have
to be made again, or every time on it is refused.

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

## Selling credits with Stripe

Players can buy 100 000 credits for each $1 on Stripe's checkout page. The
game only sends them there with their player id; the credits are paid by a
Supabase Edge Function once Stripe confirms the payment, so nobody can give
themselves credits. The Stripe account must belong to an adult. Do it all in
Stripe's **test mode** first.

1. **Database.** Run `supabase/schema.sql` again (it adds the purchases table).
2. **Product and Payment Link.** In Stripe: **Product catalog → Add product**,
   "100,000 credits", one-off price **$1.00 USD**. Then **Payment Links →
   New** for that product. Under **After payment**, choose to redirect
   customers to your website and enter the address you open the game at,
   followed by `?purchase=done` (for example
   `https://your-site/?purchase=done`). Leave quantity changes off. Copy the
   link (`https://buy.stripe.com/...`). Then do the same for a second
   product, "600,000 credits" at **$5.00 USD** (the deal: one pack free),
   and copy its link too. The server pays by the amount paid: $1 is 100 000
   credits and every $5 adds 100 000 more.
3. **The webhook function.** In Supabase: **Edge Functions → Deploy a new
   function → Via editor**, name it `stripe-webhook`, paste the whole of
   `supabase/functions/stripe-webhook/index.ts` and deploy. Open the function's
   **Details** and turn **Enforce JWT verification** off (Stripe can't send a
   Supabase login; it signs its messages instead, and the function checks
   that signature).
4. **Stripe calls it.** In Stripe: **Developers → Webhooks → Add endpoint**:
   `https://tkjiivodmmjeruhxspcz.supabase.co/functions/v1/stripe-webhook`,
   with the events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `charge.refunded` and
   `charge.dispute.created`. Copy its
   **Signing secret** (`whsec_...`).
5. **The secret.** In Supabase: **Edge Functions → Secrets → Add**:
   `STRIPE_WEBHOOK_SECRET` = the signing secret. That is the only Stripe
   secret it needs (it never calls Stripe), and it never goes in the game's
   files.
6. **Open the shop.** Admin page → **Settings → Credit shop**: paste the
   $1 link and the $5 link and save. **+ Buy credits** appears in the game's garage.
7. **Test it** in test mode with the card `4242 4242 4242 4242` (any future
   date, any CVC): the credits should arrive within a minute and the purchase
   should show on the admin page. Then make the same products, Payment Links
   and webhook in live mode, update the secret and both links, and you're live.

A refund made in Stripe, or a chargeback (a disputed payment), takes the
credits back off automatically.
