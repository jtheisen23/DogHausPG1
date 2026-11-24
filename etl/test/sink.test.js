import test from 'node:test';
import assert from 'node:assert/strict';
import { D1Sink, cleanSecret } from '../src/sink.js';

const DB = '60d086ac-ccb3-4675-91a7-568e92b3ed48';
const ACCOUNT = '0a0a421dcf08c2ca33fc134180d17698';

test('cleanSecret strips whitespace, newlines and quotes pasted with a secret', () => {
  assert.equal(cleanSecret(`${DB}\n`), DB);
  assert.equal(cleanSecret(`  "${DB}" `), DB);
  assert.equal(cleanSecret(`\`${DB}\``), DB);
  assert.equal(cleanSecret(undefined), '');
});

test('D1Sink builds the query URL from cleaned values', () => {
  const sink = new D1Sink({ accountId: `${ACCOUNT}\n`, databaseId: ` '${DB}'\r\n`, apiToken: 'tok\n' });
  assert.equal(sink.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`);
  assert.equal(sink.apiToken, 'tok');
});

test('D1Sink rejects a malformed database ID without printing it', () => {
  const bad = 'database_id = 60d086ac';
  assert.throws(
    () => new D1Sink({ accountId: ACCOUNT, databaseId: bad, apiToken: 'tok' }),
    (err) => /D1_DATABASE_ID doesn't look like the database ID/.test(err.message) &&
      /has 22 characters/.test(err.message) && /contains "_" " " "="/.test(err.message) && !err.message.includes(bad),
  );
});

test('D1Sink rejects a malformed account ID', () => {
  assert.throws(() => new D1Sink({ accountId: 'my-account', databaseId: DB, apiToken: 'tok' }), /CLOUDFLARE_ACCOUNT_ID doesn't look like/);
});
