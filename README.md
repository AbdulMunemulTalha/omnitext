# Quicky

One inbox for Facebook Page, Instagram and WhatsApp orders, built for social-commerce sellers in Bangladesh.

- **One dashboard for every channel.** Messages from Messenger, Instagram DMs and the WhatsApp Business number arrive in one list. A reply goes back to the app the customer wrote from.
- **One moderator per customer.** The first message from a new customer goes to the on-duty moderator with the fewest open chats. From then on that customer always comes back to the same moderator, even if they reply hours or days later. Other moderators can't see or reply to that customer, so two people never answer the same person.
- **Owner oversight.** The owner sees every conversation, can reply to any of them, and can move a customer to another moderator.
- **Orders from the chat.** **New order** opens a form filled in from what's already known about the customer. It adds the delivery charge for inside or outside Dhaka, works out the cash-on-delivery amount, and can send the customer an order summary on the app they wrote from.
- **Orders page.** A list of all orders, with search, status tracking (confirmed, shipped, delivered, cancelled, returned) and CSV export for courier bulk upload.
- **Saved replies.** Answers to common questions like price, delivery charge and bKash steps. A moderator types `/` and a shortcut (e.g. `/bkash`) in the reply box.
- **Landing page and guided setup.** `/` is the public landing page and the inbox lives at `/app`. A new shop is walked through four steps: business details and delivery charges, connecting Facebook Page & Instagram and WhatsApp, adding moderators, then the inbox. The wizard resumes where the owner left off, including after the Facebook login redirect.

## How assignment works

| Situation | What happens |
| --- | --- |
| New customer, moderators on duty | Goes to the on-duty moderator with the fewest open conversations. On a tie, it goes to whoever got a customer least recently. |
| New customer, nobody on duty | Waits in **Unassigned**. When a moderator switches **On duty**, waiting customers are handed out, oldest first. |
| Returning customer (even after "Mark done") | Reopens with the same moderator. |
| Moderator replies to an unassigned customer | That moderator keeps the customer from then on. |
| Owner replies | The message is sent, but the customer stays with their moderator. |
| Owner removes a moderator | That moderator's open customers go back to the queue, and the moderator is signed out. |

## Orders

| Rule | Detail |
| --- | --- |
| Phone numbers | Must be a Bangladeshi mobile. `+880 1711-111111`, `8801711111111` and `01711111111` are all stored as `01711111111`. |
| Delivery charge | The default comes from **Settings → Delivery charges**, by area (inside/outside Dhaka). It can be changed per order, e.g. for free-delivery offers. |
| Cash on delivery | Products + delivery − discount − advance paid. The form rejects a discount or advance larger than the total. |
| Who sees an order | The owner sees all orders. A moderator sees the orders they took, plus orders for customers assigned to them. |
| Repeat customers | The form fills in the name, phone and address from the customer's last order. For WhatsApp, the phone comes from the customer's number. |
| Summary message | If Meta won't accept the summary (for example, WhatsApp after 24 hours), the order is still saved and the moderator sees why the message wasn't sent. |
| CSV export | Uses the current filter. Starts with a UTF-8 BOM so Excel shows Bangla names correctly. Text a customer typed can't run as a spreadsheet formula. |

## Run it locally

Needs Node.js 22.13 or newer. The database is the built-in `node:sqlite`, so there is nothing else to install.

```bash
npm install
npm run seed          # demo shop: owner@demo.test, nadia@demo.test, karim@demo.test / password123
DRY_RUN=1 npm start   # http://localhost:3000
```

Sign in as the owner in one browser window and as the moderators in two private windows. Under **Settings → Test a customer message** you can play a customer writing in, and watch the message reach a moderator live.

```bash
npm test
```

## Deploying

Quicky needs a public **https** address: Meta won't send webhooks or finish a Facebook login otherwise. The examples use `heyquicky.com`; replace it with your domain.

First, create the `.env` file from `.env.example`:

- `META_APP_SECRET`: from App settings → Basic in the Meta dashboard.
- `META_VERIFY_TOKEN` and `TOKEN_ENCRYPTION_KEY`: generate each one with the command written next to it in `.env.example`.
- **Back up** `TOKEN_ENCRYPTION_KEY` somewhere safe. If it's lost, every channel has to be connected again.

### Option A: VPS with Docker (recommended)

You need any Linux server with Docker installed.

1. Point the domain's DNS **A record** at the server's IP address.
2. Run:

```bash
git clone https://github.com/AbdulMunemulTalha/omnitext.git && cd omnitext
cp .env.example .env && nano .env      # fill in the secrets
docker compose up -d --build
```

Caddy gets the HTTPS certificate for you. The database is stored in the `quicky-data` volume. To update later, run `git pull && docker compose up -d --build`.

### Option A2: Hostinger VPS that already runs another site

Use `deploy/hostinger/docker-compose.yml` when another project's web server already uses ports 80 and 443.

1. Create a project in hPanel → VPS → **Docker Manager** from that file. Name it `quicky`, and put the `.env` values in its environment.
   - It runs as its own project, with its own data volume and network, and uses no public ports.
   - It downloads the branch from GitHub on every start, so **restarting the project deploys the latest code**.
2. Let the existing web server forward the domain to Quicky. If that server is Caddy, run this in the VPS terminal (change the folder and container names to match yours):

```bash
docker network connect quicky_edge bwg-portal-caddy-1
cp /opt/bwg-portal/Caddyfile /opt/bwg-portal/Caddyfile.bak
printf '\n# Quicky\nheyquicky.com {\n\treverse_proxy quicky-app:3000\n}\nwww.heyquicky.com {\n\tredir https://heyquicky.com{uri} permanent\n}\n' >> /opt/bwg-portal/Caddyfile
docker exec bwg-portal-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

If the new config has a mistake, `caddy reload` rejects it and the old config keeps running. Recreating the other project's Caddy container removes the network connection, so run the first line again after that.

To undo all of it, run:

```bash
cp /opt/bwg-portal/Caddyfile.bak /opt/bwg-portal/Caddyfile
docker exec bwg-portal-caddy-1 caddy reload --config /etc/caddy/Caddyfile
docker network disconnect quicky_edge bwg-portal-caddy-1
```

### Option B: cPanel hosting ("Setup Node.js App")

1. In cPanel, open **Setup Node.js App** and create an application:
   - **Node.js version:** 22.13 or newer. If your host doesn't offer it, use Option A.
   - **Application root:** the folder you uploaded the code to.
   - **Application URL:** your domain.
   - **Startup file:** `src/server.js`.
2. Add every line from `.env.example` as an environment variable. Leave out `PORT`; cPanel sets it.
3. Click **Run NPM Install**, then **Restart**.
4. Turn on HTTPS for the domain with cPanel's SSL/TLS tool or AutoSSL.

### Check it

Open these in a browser:

- `https://heyquicky.com/healthz` should show `{"ok":true}`.
- `https://heyquicky.com/privacy` should show the privacy policy.

Then open `https://heyquicky.com`, create your business account, and continue with **Meta app settings** below.

### Meta app settings for this domain

Values to enter for the Quicky app (`1113995110986950`):

| Where in the Meta dashboard | Value |
| --- | --- |
| App settings → Basic → Privacy policy URL | `https://heyquicky.com/privacy` |
| App settings → Basic → Terms of service URL | `https://heyquicky.com/terms` |
| App settings → Basic → User data deletion → Data deletion instructions URL | `https://heyquicky.com/data-deletion` |
| App settings → Basic → App domains | `heyquicky.com` |
| Facebook Login for Business → Settings → Valid OAuth Redirect URIs | `https://heyquicky.com/auth/facebook/callback` |
| Facebook Login for Business → Settings → Login with the JavaScript SDK | On |
| Facebook Login for Business → Settings → Allowed Domains for the JavaScript SDK | `https://heyquicky.com` |
| Webhooks (Messenger/Page, Instagram, WhatsApp Business Account): callback URL | `https://heyquicky.com/webhooks/meta` |
| Webhooks: verify token | The `META_VERIFY_TOKEN` from your `.env` |

## Connecting real channels

All three channels use one Meta app and one webhook URL: `https://<your-domain>/webhooks/meta`.

1. Create an app at developers.facebook.com (type **Business**). Add the **Messenger**, **Instagram** and **WhatsApp** products.
2. In each product's webhook settings, enter the callback URL above and the same verify token as `META_VERIFY_TOKEN`. Subscribe to:
   - Messenger: `messages`, `message_echoes`
   - Instagram: `messages`
   - WhatsApp: `messages`
3. Set up one-click connection (next section). After that, sellers connect their accounts themselves from **Settings → Connected channels**.

### One-click connection

**Facebook Page and Instagram**

1. The owner clicks **Connect Facebook Page & Instagram** and logs in to Facebook.
2. They tick their Pages. Facebook sends them back to the dashboard.
3. They choose which Pages, and which Instagram accounts linked to those Pages, should come into the inbox.
4. Quicky then:
   - subscribes each chosen Page to the app's webhooks
   - saves each Page's token, which doesn't expire because it comes from a long-lived login

**WhatsApp**

1. The owner clicks **Connect WhatsApp**. Meta's Embedded Signup popup opens.
2. In the popup, they create or choose a WhatsApp Business account and verify a phone number.
3. Quicky then:
   - exchanges the signup code for a business token
   - subscribes the app to the WhatsApp Business account
   - registers the number for the Cloud API, and shows the owner the six-digit two-step verification PIN once

**Setup in the Meta app dashboard**

- **Facebook Login for Business → Settings:**
  - Add `https://<your-domain>/auth/facebook/callback` to **Valid OAuth Redirect URIs**.
  - Turn on **Login with the JavaScript SDK**.
  - Add your domain to **Allowed Domains for the JavaScript SDK**. HTTPS is required.
- **Facebook Login for Business → Configurations:**
  - **Optional** (`META_LOGIN_CONFIG_ID`): a configuration with the permissions `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_messages` and `business_management`. Without it, the login asks for these permissions directly.
  - **For WhatsApp** (`META_WHATSAPP_CONFIG_ID`): a configuration using the **WhatsApp Embedded Signup** variation, with `whatsapp_business_management` and `whatsapp_business_messaging`.
- **App Review:** Until the app passes App Review and is switched to Live, only people with a role on the app (admins, developers, testers) can connect. That's fine for testing with your own Page and number.

**Reconnecting**

- If Meta stops accepting a stored token (for example, the seller changed their Facebook password or removed the app), the channel shows **"Facebook access expired: connect again"**.
- Connecting the same Page or number again refreshes the token. Its conversations are kept.
- A Page can belong to only one Quicky account at a time.

The manual form (ID plus access token) is still under **Connect manually (advanced)**. Use it for testing, or for system-user tokens you create yourself.

| Variable | Purpose |
| --- | --- |
| `META_APP_ID`, `META_APP_SECRET` | Your Meta app. Turns on one-click connection and checks the `X-Hub-Signature-256` signature on webhooks. The secret is required in production. |
| `META_VERIFY_TOKEN` | Any string you choose. It must match the one in the Meta dashboard. |
| `META_LOGIN_CONFIG_ID` | Optional Facebook Login for Business configuration for Messenger and Instagram. |
| `META_WHATSAPP_CONFIG_ID` | Embedded Signup configuration. Turns on **Connect WhatsApp**. |
| `PUBLIC_URL` | Your public https address, e.g. `https://inbox.example.com`. Used to build the login redirect. Set it when running behind a proxy or load balancer. |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes as hex. Access tokens are stored encrypted with AES-256-GCM. Required in production; the server won't start without it. Create one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it safe: if it's lost, every channel has to be connected again. |
| `META_GRAPH_VERSION` | Graph API version. Defaults to `v23.0`. |
| `DATABASE_PATH` | SQLite file location. Defaults to `data/quicky.db`. |
| `DRY_RUN` | `1` stores replies without sending them to Meta. |
| `PORT`, `NODE_ENV` | Standard. |

If a channel has no access token, it runs in test mode: replies are stored but never sent.

### Meta rules the inbox enforces

- **24-hour window:** You can reply freely for 24 hours after the customer's last message.
- **Messenger and Instagram:** From 24 hours to 7 days, replies go out with the `HUMAN_AGENT` tag. This needs the Human Agent permission in App Review. After 7 days, Meta refuses replies.
- **WhatsApp:** After 24 hours, only pre-approved template messages are allowed. The inbox blocks free-text replies and explains why.
- **Replies from the phone:** Replies sent from the Facebook Page app or Business Suite still show up in the history, through message echoes.

### Before taking paying customers

- **App Review:** Request Advanced Access for `pages_messaging`, `instagram_manage_messages` and `whatsapp_business_messaging`. Meta also requires **Business Verification** for your company. These usually take the longest, so start early.
- **WhatsApp Cloud API costs:** Meta charges per message, so price your plans to cover it.

## Project layout

```
src/
  server.js            entry point
  app.js               Express + Socket.IO wiring
  db.js                schema (SQLite)
  auth.js              password hashing, sessions
  assignment.js        moderator routing
  inbox.js             storing messages, replies, permissions
  orders.js            order validation, totals, summary message, CSV
  platforms/meta.js    webhook parsing, signatures, Send API, messaging windows
  platforms/metaConnect.js  Facebook login, Page listing, WhatsApp Embedded Signup
  secrets.js           access token encryption
  routes/              REST API and the webhook endpoint
public/                landing page (index.html), app and onboarding (app.html), plain HTML/JS, no build step
test/                  node:test suites
```

## Roadmap

1. **Courier booking:** Send orders straight to Steadfast, Pathao or RedX through their APIs, and save the tracking code on the order. A product catalog with stock, so moderators pick products instead of typing them.
2. **Order summary in Bangla:** Let the owner edit the summary message, including the language.
3. **WhatsApp templates and media:** Send templates after 24 hours, and show WhatsApp images and voice notes.
4. **One customer across apps:** Link a customer who writes on both Messenger and WhatsApp, so the same moderator gets both.
5. **Facebook post comments:** Handle "price?" comments under posts (`feed` webhook) and reply privately.
6. **Reports and billing:** Response time and orders per moderator. Plans billed per seat or per channel, with bKash/SSLCommerz payments.
7. **Scaling:** Postgres and a job queue for webhook processing once a single SQLite file is no longer enough.
