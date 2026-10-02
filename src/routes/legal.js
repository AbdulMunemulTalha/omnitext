import { Router } from 'express';

// Pages Meta's App Review asks for: privacy policy, terms of service and data
// deletion instructions. Their URLs go into App settings → Basic.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, { operator, supportEmail }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(operator)}</title>
<style>
  :root { --bg: #ffffff; --text: #1c1f24; --muted: #6b7280; --accent: #1f6feb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --text: #e7e9ee; --muted: #9aa1ad; --accent: #4c8dff; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { margin-bottom: 4px; }
  h2 { margin-top: 32px; font-size: 20px; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  nav { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 40px; font-size: 14px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
<nav><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/data-deletion">Data deletion</a><a href="/">Sign in</a></nav>
</main>
</body>
</html>`;
}

export function legalRoutes(config) {
  const router = Router();
  const operator = config.legal.operator;
  const email = config.legal.supportEmail;
  const contact = email
    ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
    : 'the contact address shown in your account';
  const updated = `<p class="muted">Last updated: ${escapeHtml(config.legal.updated)}</p>`;
  const opts = { operator, supportEmail: email };
  const op = escapeHtml(operator);

  router.get('/privacy', (_req, res) => res.send(page('Privacy policy', `${updated}
<p>${op} ("we") runs an online inbox that lets businesses read and answer messages their customers send through
Facebook Messenger, Instagram and WhatsApp, and record the orders that come out of those conversations.
This policy explains what data we handle and why.</p>

<h2>Who this covers</h2>
<p><strong>Businesses</strong> that sign up for ${op} and the team members they invite, and
<strong>customers</strong> of those businesses who message them on Messenger, Instagram or WhatsApp.
For customer data, the business decides what to collect and why; we process it on the business's behalf.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account details:</strong> business name, team members' names and email addresses, and passwords (stored only as one-way hashes).</li>
  <li><strong>Connected accounts:</strong> the IDs and names of the Facebook Pages, Instagram accounts and WhatsApp numbers a business connects, and the access tokens Meta issues for them. Tokens are stored encrypted.</li>
  <li><strong>Messages:</strong> messages exchanged between a business and its customers on connected accounts, the customer's name and platform ID as provided by Meta, links to attachments, and delivery status.</li>
  <li><strong>Orders:</strong> details a business records for an order, such as customer name, phone number, delivery address, products and amounts.</li>
  <li><strong>Technical data:</strong> basic server logs (such as IP address and time of request) used to keep the service secure and working.</li>
</ul>

<h2>How we use it</h2>
<p>Only to provide the service: showing messages in the business's inbox, sending the business's replies back through the same
platform, assigning conversations to team members, and keeping order records. We do not sell personal data, use it for
advertising, or use data received from Meta for any purpose other than providing ${op} to the business that connected the account.</p>

<h2>Who we share it with</h2>
<ul>
  <li><strong>Meta Platforms</strong>, to receive and deliver messages on Messenger, Instagram and WhatsApp.</li>
  <li><strong>Our hosting provider</strong>, which stores the data on our behalf.</li>
  <li>Anyone else only when the business itself exports or sends the data (for example, uploading an order list to a courier), or when required by law.</li>
</ul>

<h2>How long we keep it</h2>
<p>For as long as the business's account is active. When a business disconnects an account, its conversations are deleted.
When a business closes its account or asks for deletion, we delete its data within 30 days, except where the law requires us to keep it.</p>

<h2>Security</h2>
<p>Connections are encrypted with HTTPS, access tokens are encrypted at rest, passwords are hashed, and moderators only see
their own customers and customers still waiting for a moderator.</p>

<h2>Your choices</h2>
<p>You can ask us for a copy of your data, or ask us to correct or delete it. See <a href="/data-deletion">data deletion</a>,
or contact us at ${contact}. If you are a customer of a business that uses ${op}, you can also contact that business directly.</p>

<h2>Changes</h2>
<p>We will post any changes to this policy on this page and update the date above.</p>

<h2>Contact</h2>
<p>${op}, ${contact}</p>`, opts)));

  router.get('/terms', (_req, res) => res.send(page('Terms of service', `${updated}
<p>By creating an account or using ${op} you agree to these terms.</p>
<h2>The service</h2>
<p>${op} lets a business manage messages from its own Facebook Pages, Instagram accounts and WhatsApp numbers in one inbox
and record orders. You must have the right to manage every account you connect.</p>
<h2>Your responsibilities</h2>
<ul>
  <li>Follow Meta's terms and policies, including the Messenger, Instagram and WhatsApp Business policies, when messaging customers.</li>
  <li>Only message customers in ways those platforms allow, and do not send spam or unlawful content.</li>
  <li>Keep your team members' passwords safe and remove people who should no longer have access.</li>
  <li>Handle your customers' personal data lawfully. You are responsible for the data you collect from your customers.</li>
</ul>
<h2>Availability</h2>
<p>We work to keep ${op} running, but it is provided "as is". Messaging depends on Meta's platforms, which may change or be
unavailable, and we are not liable for losses caused by outages or by changes Meta makes.</p>
<h2>Ending the service</h2>
<p>You can stop using ${op} at any time and ask us to delete your data. We may suspend accounts that break these terms or Meta's policies.</p>
<h2>Contact</h2>
<p>${contact}</p>`, opts)));

  router.get('/data-deletion', (_req, res) => res.send(page('Data deletion', `${updated}
<p>You can have your data removed from ${op} at any time.</p>
<h2>If you are a business using ${op}</h2>
<ol>
  <li>To remove a single Page, Instagram account or WhatsApp number: open <strong>Settings → Connected channels</strong> and click
    <strong>Disconnect</strong>. Its conversations are deleted straight away.</li>
  <li>To stop ${op} from accessing your Facebook account: on Facebook go to <strong>Settings &amp; privacy → Settings →
    Business integrations</strong>, select ${op} and click <strong>Remove</strong>.</li>
  <li>To delete your whole account and all of its data: email ${contact} from your account's email address with the subject
    "Delete my account". We delete everything within 30 days and confirm by email.</li>
</ol>
<h2>If you messaged a business that uses ${op}</h2>
<p>Ask that business to delete your conversation, or email ${contact} with the name of the business and the platform you
messaged them on (Messenger, Instagram or WhatsApp). We will delete your messages and any order details within 30 days and confirm.</p>`, opts)));

  return router;
}
