/**
 * Client-half checks. The bundle is plain browser JavaScript that registers a
 * factory on the module loader, so it is loaded in a VM with a stubbed React and
 * only its pure helpers are exercised.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(HERE, '..', 'client.js'), 'utf8');

let captured = null;
const react = {
  createElement: () => ({}),
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => undefined],
};
const context = createContext({
  window: {
    __ModuleLoader__: {
      load: (options) => {
        captured = options;
      },
    },
  },
  document: { addEventListener: () => undefined, removeEventListener: () => undefined },
  fetch: () => Promise.reject(new Error('no network in tests')),
  console,
});
runInContext(source, context);

assert.ok(captured, 'client bundle registered itself');
assert.equal(captured.id, 'dsh-composer-suggestion');
const exported = captured.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`unexpected require(${name})`);
});
const {
  resolveLanguage, completionTail, insertAtCaret, looksSecret, codePointLength,
  cacheGet, cacheSet, banksFor, pick, hashOf, MIN_ROOM_PX,
} = exported.__internals;

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

console.log('client.test');

check('apply registers both slots and runtime locale strings', () => {
  const calls = [];
  const ctx = {
    effect: (fn) => { calls.push(['effect', typeof fn]); return typeof fn === 'function' ? fn() : () => undefined; },
    locale: {
      register: (ns, dicts) => { calls.push(['locale', ns, Object.keys(dicts.zh)]); return () => undefined; },
      getLocale: () => ({ active: 'zh' }),
    },
    slots: {
      inject: (name, fn) => { calls.push(['inject', name]); fn(); return () => undefined; },
      register: (options) => { calls.push(['register', options.name, options.id]); return () => undefined; },
    },
  };
  exported.apply(ctx);
  const registered = calls.filter((call) => call[0] === 'register').map((call) => call[1]);
  assert.deepEqual(registered, ['conversation.input.overlay', 'conversation.composer.dock']);
  const locale = calls.find((call) => call[0] === 'locale');
  assert.ok(locale && locale[2].includes('hint'), 'runtime dict carries the hint key');
});

check('language follows the draft before the UI locale', () => {
  assert.equal(resolveLanguage('帮我看看', 'en'), 'zh');
  assert.equal(resolveLanguage('please check', 'zh'), 'en');
  assert.equal(resolveLanguage('', 'zh'), 'zh');
  assert.equal(resolveLanguage('', 'en'), 'en');
});

check('banksFor selects the matching bank', () => {
  assert.equal(banksFor('zh').recommends.length, 6);
  assert.ok(banksFor('en').sentences[0].startsWith('Continue'));
});

check('completionTail returns the tail for a matching prefix', () => {
  assert.equal(completionTail('帮我把', banksFor('zh')), '上面的方案直接实现出来');
});
check('completionTail trims trailing whitespace', () => {
  assert.equal(completionTail('帮我把  ', banksFor('zh')), '上面的方案直接实现出来');
});
check('completionTail is null for a non-prefix draft', () => {
  assert.equal(completionTail('今天天气', banksFor('zh')), null);
});
check('completionTail is null for an exact sentence', () => {
  assert.equal(completionTail('把这个功能做成一个插件', banksFor('zh')), null);
});
check('completionTail is null for an empty draft', () => {
  assert.equal(completionTail('', banksFor('zh')), null);
});

function actions(span, result) {
  const calls = [];
  const api = {
    captureInsertion: () => span,
    insertText: (text) => {
      calls.push(text);
      return result;
    },
  };
  return { api, calls };
}

check('insertAtCaret accepts a caret at the draft end', () => {
  const { api, calls } = actions({ start: 3, end: 3, draftRev: 1 }, true);
  assert.equal(insertAtCaret(api, 'xxx', '帮我把'), true);
  assert.deepEqual(calls, ['xxx']);
});
check('insertAtCaret refuses a caret in the middle', () => {
  assert.equal(insertAtCaret(actions({ start: 1, end: 1 }, true).api, 'xxx', '帮我把'), false);
});
check('insertAtCaret refuses an active selection', () => {
  assert.equal(insertAtCaret(actions({ start: 1, end: 3 }, true).api, 'xxx', '帮我把'), false);
});
check('insertAtCaret treats a void return as success', () => {
  assert.equal(insertAtCaret(actions({ start: 3, end: 3 }, undefined).api, 'xxx', '帮我把'), true);
});
check('insertAtCaret treats an explicit false as failure', () => {
  assert.equal(insertAtCaret(actions({ start: 3, end: 3 }, false).api, 'xxx', '帮我把'), false);
});
check('insertAtCaret no-ops without inputActions', () => {
  assert.equal(insertAtCaret(null, 'xxx', '帮我把'), false);
});
check('insertAtCaret tolerates code-point offsets (emoji draft)', () => {
  const draft = '👍帮我把';
  assert.equal(codePointLength(draft), 4);
  assert.equal(insertAtCaret(actions({ start: 4, end: 4 }, true).api, '上面的方案', draft), true);
});

check('looksSecret blocks credential drafts', () => {
  assert.equal(looksSecret('sk-abcdefghijklmnopqrstuvwx'), true);
  assert.equal(looksSecret('token: abcdefgh12345'), true);
  assert.equal(looksSecret('帮我把这段代码补上测试'), false);
});

check('recommendation cache is bounded and language-scoped', () => {
  for (let index = 0; index < 60; index += 1) cacheSet(`s:zh:recommend:${index}`, `x${index}`);
  let alive = 0;
  for (let index = 0; index < 60; index += 1) {
    if (cacheGet(`s:zh:recommend:${index}`) !== null) alive += 1;
  }
  assert.equal(alive, 32);
  assert.equal(cacheGet('missing'), null);
});

check('pick and hashOf are deterministic', () => {
  const pool = ['a', 'b', 'c'];
  assert.equal(pick(pool, 7), pick(pool, 7));
  assert.equal(hashOf('abc'), hashOf('abc'));
  assert.notEqual(hashOf('abc'), hashOf('abd'));
  assert.ok(MIN_ROOM_PX >= 60);
});

console.log(`client.test: ${passed} passed`);
