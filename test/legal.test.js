import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { setup } from './helpers.js';

test('serves the privacy policy, terms and data deletion pages Meta asks for', async () => {
  const ctx = setup({ env: { OPERATOR_NAME: 'Quicky <BD>', SUPPORT_EMAIL: 'help@example.com' } });
  const { server } = createApp(ctx.db, ctx.config);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/privacy', '/terms', '/data-deletion']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const html = await res.text();
      assert.match(html, /mailto:help@example\.com/, path);
      assert.match(html, /Quicky &lt;BD&gt;/, `${path} escapes the operator name`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
