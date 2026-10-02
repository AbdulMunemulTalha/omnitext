# OmniText

One inbox for Facebook Page, Instagram and WhatsApp orders, built for social-commerce sellers in Bangladesh.

- **One dashboard for every channel.** Messages from Messenger, Instagram DMs and the WhatsApp Business number arrive in one list. A reply goes back to the app the customer wrote from.
- **One moderator per customer.** The first message from a new customer goes to the on-duty moderator with the fewest open chats. From then on that customer always comes back to the same moderator, even if they reply hours or days later. Other moderators can't see or reply to that customer, so two people never answer the same person.
- **Owner oversight.** The owner sees every conversation, can reply to any of them, and can move a customer to another moderator.
- **Orders from the chat.** **New order** opens a form filled in from what's already known about the customer. It adds the delivery charge for inside or outside Dhaka, works out the cash-on-delivery amount, and can send the customer an order summary on the app they wrote from.
- **Orders page.** A list of all orders, with search, status tracking (confirmed, shipped, delivered, cancelled, returned) and CSV export for courier bulk upload.
- **Saved replies.** Answers to common questions like price, delivery charge and bKash steps. A moderator types `/` and a shortcut (e.g. `/bkash`) in the reply box.

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

Sign in as the owner in one browser window and as the moderators in two private windows. Under **Team & channels → Test a customer message** you can play a customer writing in, and watch the message reach a moderator live.

```bash
npm test
```

## Connecting real channels

All three channels use one Meta app and one webhook URL: `https://<your-domain>/webhooks/meta`.

1. Create an app at developers.facebook.com (type **Business**). Add the **Messenger**, **Instagram** and **WhatsApp** products.
2. In each product's webhook settings, enter the callback URL above and the same verify token as `META_VERIFY_TOKEN`. Subscribe to:
   - Messenger: `messages`, `message_echoes`
   - Instagram: `messages`
   - WhatsApp: `messages`
3. In **Team & channels → Connected channels**, add each account:
   - **Facebook Page:** Page ID plus a Page access token.
   - **Instagram:** Instagram professional account ID plus the access token of the linked Facebook Page.
   - **WhatsApp:** Phone number ID (not the phone number) plus a system-user access token.

| Variable | Purpose |
| --- | --- |
| `META_APP_SECRET` | Checks the `X-Hub-Signature-256` signature on webhooks. Required in production. |
| `META_VERIFY_TOKEN` | Any string you choose. It must match the one in the Meta dashboard. |
| `META_APP_ID` | Lets the app ignore Messenger/Instagram echoes of replies it sent itself. |
| `META_GRAPH_VERSION` | Graph API version. Defaults to `v23.0`. |
| `DATABASE_PATH` | SQLite file location. Defaults to `data/omnitext.db`. |
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
  routes/              REST API and the webhook endpoint
public/                dashboard (plain HTML/JS, no build step)
test/                  node:test suites
```

## Roadmap

1. **Connect Facebook in one click:** Facebook Login for Business plus WhatsApp Embedded Signup, so sellers don't paste IDs and tokens. Store tokens encrypted.
2. **Courier booking:** Send orders straight to Steadfast, Pathao or RedX through their APIs, and save the tracking code on the order. A product catalog with stock, so moderators pick products instead of typing them.
3. **Order summary in Bangla:** Let the owner edit the summary message, including the language.
4. **WhatsApp templates and media:** Send templates after 24 hours, and show WhatsApp images and voice notes.
5. **One customer across apps:** Link a customer who writes on both Messenger and WhatsApp, so the same moderator gets both.
6. **Facebook post comments:** Handle "price?" comments under posts (`feed` webhook) and reply privately.
7. **Reports and billing:** Response time and orders per moderator. Plans billed per seat or per channel, with bKash/SSLCommerz payments.
8. **Scaling:** Postgres and a job queue for webhook processing once a single SQLite file is no longer enough.
