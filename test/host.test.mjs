/** Host-half checks: request admission, output cleanup, rate limiting. */
import assert from 'node:assert/strict';
import { __internals } from '../host.js';

const { tidy, cutAtBoundary, requestAllowed, takeToken, SECRET_PATTERN } = __internals;
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
    process.exitCode = 1;
  }
}

function request({ method = 'POST', headers = {} } = {}) {
  return { method, headers: { host: '127.0.0.1:2179', 'x-composer-suggestion': '1', ...headers } };
}

console.log('host.test');

check('GET is refused', () => {
  assert.equal(requestAllowed(request({ method: 'GET' })), 'method');
});
check('missing custom header is refused', () => {
  const headers = { host: '127.0.0.1:2179' };
  assert.equal(requestAllowed({ method: 'POST', headers }), 'method');
});
check('non-loopback Host is refused (DNS rebinding)', () => {
  assert.equal(requestAllowed(request({ headers: { host: 'evil.example:2179' } })), 'host');
});
check('cross-site fetch metadata is refused', () => {
  assert.equal(requestAllowed(request({ headers: { 'sec-fetch-site': 'cross-site' } })), 'origin');
});
check('foreign Origin is refused', () => {
  assert.equal(requestAllowed(request({ headers: { origin: 'https://evil.example' } })), 'origin');
});
check('same-origin page request is admitted', () => {
  assert.equal(requestAllowed(request({ headers: { origin: 'http://127.0.0.1:2179', 'sec-fetch-site': 'same-origin' } })), null);
});
check('localhost Host is admitted', () => {
  assert.equal(requestAllowed(request({ headers: { host: 'localhost:2179' } })), null);
});

check('tidy strips an echoed draft', () => {
  assert.equal(tidy('把刚才的改动整理成清单', '把刚才的改动'), '整理成清单');
});
check('tidy removes fences and quotes', () => {
  assert.equal(tidy('```text\n“跑一遍测试。”\n```', ''), '跑一遍测试。');
});
check('tidy keeps the first non-empty line', () => {
  assert.equal(tidy('\n\n第一行\n第二行', ''), '第一行');
});
check('tidy never echoes the whole draft back', () => {
  assert.equal(tidy('把刚才的改动', '把刚才的改动'), '');
});

check('cutAtBoundary prefers sentence punctuation', () => {
  const text = '先把这段代码改成 TypeScript，然后再补上单元测试';
  const cut = cutAtBoundary(text, 26);
  assert.ok(cut.length <= 26, `length ${cut.length}`);
  assert.ok(cut.endsWith('，'), `ends with ${cut.slice(-1)}`);
});
check('cutAtBoundary falls back to an ellipsis', () => {
  const cut = cutAtBoundary('a'.repeat(200), 20);
  assert.equal(cut.length, 20);
  assert.ok(cut.endsWith('…'));
});
check('cutAtBoundary leaves short text alone', () => {
  assert.equal(cutAtBoundary('短句。', 20), '短句。');
});

check('secret shapes are detected', () => {
  for (const sample of ['sk-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz', 'AKIAABCDEFGHIJKLMNOP', 'password: hunter22']) {
    assert.ok(SECRET_PATTERN.test(sample), sample);
  }
  assert.equal(SECRET_PATTERN.test('帮我把这段代码改成 TypeScript'), false);
});

check('a session bucket bursts then throttles', () => {
  const key = `test-${Date.now()}`;
  let allowed = 0;
  for (let index = 0; index < 40; index += 1) {
    if (takeToken(key, Date.now())) allowed += 1;
  }
  assert.equal(allowed, 30);
  assert.equal(takeToken(key, Date.now() + 61_000), true);
});

console.log(`host.test: ${passed} passed`);
