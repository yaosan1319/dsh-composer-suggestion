/**
 * Host half of the composer-suggestion bundle.
 *
 * Exposes one loopback HTTP route that turns the recent Session transcript plus
 * the composer draft into a short suggestion with the configured model. The
 * Client half renders that text as ghost completion / a recommendation row and
 * keeps its built-in phrase bank as the instant fallback.
 */

const ROUTE = '/dsh-composer-suggestion/suggest';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_DRAFT_CHARS = 400;
const MAX_MESSAGE_CHARS = 1200;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_SUGGESTION_CHARS = 120;
const REQUEST_BUDGET_MS = 9000;
const SESSION_BURST = 30;
const SESSION_WINDOW_MS = 60_000;

export const name = 'composer-suggestion-host';
export const inject = ['webServer', 'sessions', 'llm'];

/** Credential shapes that must never leave the composer. */
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*\S{8,})/iu;

/** Plain-text projection of one stored message. */
function messageText(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Last few human and assistant messages of a live Session, oldest first. */
function recentContext(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return [];
  let events;
  try {
    events = session.snapshotEvents();
  } catch (error) {
    return [];
  }
  const picked = [];
  for (let index = events.length - 1; index >= 0 && picked.length < MAX_CONTEXT_MESSAGES; index -= 1) {
    const event = events[index];
    if (!event || typeof event.type !== 'string') continue;
    let role = null;
    let text = '';
    if (event.type === 'user/message') {
      role = 'user';
      text = messageText(event.data);
    } else if (event.type === 'assistant/message') {
      role = 'assistant';
      text = messageText(event.data && event.data.message);
    } else {
      continue;
    }
    if (text.length === 0) continue;
    picked.push({ role, text: text.slice(0, MAX_MESSAGE_CHARS) });
  }
  return picked.reverse();
}

function systemPrompt(mode, language) {
  const chinese = String(language || '').toLowerCase().startsWith('zh');
  const target = chinese ? '简体中文' : 'English';
  if (mode === 'continuation') {
    return [
      'You complete the unfinished draft a developer is typing into an AI coding agent.',
      'Reply with ONLY the text that comes next, continuing the draft seamlessly from its final character.',
      'Never repeat or paraphrase the draft itself.',
      'No quotes, no prefix, no explanation, no markdown fence, at most one short sentence under 60 characters.',
      `Write in ${target}, matching the draft's language.`,
    ].join('\n');
  }
  return [
    'You propose the single next prompt a developer is most likely to send to an AI coding agent, given the conversation so far.',
    'Reply with ONLY that prompt: one short imperative sentence a user would actually type, under 60 characters.',
    'No quotes, no numbering, no explanation, no markdown.',
    `Write in ${target}, matching the conversation's language.`,
  ].join('\n');
}

function userPrompt(mode, context, draft) {
  const lines = [];
  if (context.length > 0) {
    lines.push('Conversation so far (oldest first):');
    for (const message of context) {
      lines.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.text}`);
    }
  } else {
    lines.push('Conversation so far: (empty)');
  }
  lines.push('');
  if (mode === 'continuation') {
    lines.push(`Unfinished draft: ${draft}`);
    lines.push('Provide only the continuation text.');
  } else {
    lines.push('Provide only the next prompt.');
  }
  return lines.join('\n');
}

/** Ask the configured model for one suggestion, streaming text deltas. */
async function generate(ctx, { mode, context, draft, language, signal }) {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: systemPrompt(mode, language) }] },
    { role: 'user', content: [{ type: 'text', text: userPrompt(mode, context, draft) }] },
  ];
  const routes = [];
  const defaultModel = ctx.get('agentDefaultModel');
  if (defaultModel && typeof defaultModel.currentSelection === 'function') {
    try {
      const selection = defaultModel.currentSelection();
      if (selection && selection.provider && selection.model) {
        routes.push({ provider: selection.provider, model: selection.model });
      }
    } catch (error) {
      // Fall through to the provider list.
    }
  }
  if (routes.length === 0) throw new Error('composer-suggestion: no default model selection');

  let text = '';
  for (const route of routes) {
    for await (const chunk of ctx.llm.stream({ ...route, messages, signal })) {
      if (!chunk || typeof chunk.type !== 'string') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk.type === 'finish') break;
    }
    if (text.trim().length > 0) break;
  }
  return text.trim();
}

/** Drop wrapping quotes, fences and an echoed draft from model output. */
function tidy(text, draft) {
  let value = String(text || '').trim();
  value = value.replace(/^```[a-zA-Z]*\s*/u, '').replace(/```$/u, '').trim();
  const quoted = /^["'“”『「'](?<inner>[\s\S]*?)["'“”』」']$/u.exec(value);
  if (quoted && quoted.groups && quoted.groups.inner) value = quoted.groups.inner.trim();
  const firstLine = value.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) || '';
  let result = firstLine;
  const echo = String(draft || '').trim();
  if (echo.length > 0 && result.startsWith(echo)) {
    // An exact echo leaves nothing to append; a longer echo keeps only the tail.
    result = result.slice(echo.length).trim();
  }
  return cutAtBoundary(result, MAX_SUGGESTION_CHARS);
}

/** Cut at the last sentence or word boundary instead of mid-token. */
function cutAtBoundary(text, limit) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  const boundary = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('．'), head.lastIndexOf('，'),
    head.lastIndexOf('、'), head.lastIndexOf('；'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('. '), head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' '),
  );
  if (boundary >= Math.floor(limit * 0.3)) {
    return head.slice(0, boundary + 1).trim();
  }
  return `${head.slice(0, limit - 1).trim()}…`;
}

/** One token bucket per Session, so a page cannot spend the model budget. */
const buckets = new Map();

function takeToken(sessionId, now) {
  const key = sessionId || 'anonymous';
  const current = buckets.get(key);
  if (current === undefined || now - current.windowStart >= SESSION_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (current.count >= SESSION_BURST) return false;
  current.count += 1;
  return true;
}

/** Accept only a same-origin browser request addressed to the loopback host. */
function requestAllowed(request) {
  if (request.method !== 'POST' || request.headers['x-composer-suggestion'] !== '1') return 'method';
  const host = String(request.headers.host || '');
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/u.test(host)) return 'host';
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'origin';
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch (error) {
      return 'origin';
    }
    if (`${parsed.host}` !== host) return 'origin';
  }
  return null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('invalid json'));
      }
    });
    request.on('error', reject);
  });
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function handle(ctx, request, response) {
  const refusal = requestAllowed(request);
  if (refusal !== null) {
    send(response, 405, { error: refusal });
    return;
  }
  let payload;
  try {
    payload = await readBody(request);
  } catch (error) {
    send(response, 400, { error: String(error && error.message) });
    return;
  }
  const mode = payload && payload.mode === 'continuation' ? 'continuation' : 'recommend';
  const draft = typeof payload?.draft === 'string' ? payload.draft.slice(0, MAX_DRAFT_CHARS) : '';
  const language = typeof payload?.language === 'string' ? payload.language : 'en';
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;

  if (SECRET_PATTERN.test(draft)) {
    send(response, 200, { mode, text: '', skipped: 'secret' });
    return;
  }
  if (!takeToken(sessionId, Date.now())) {
    send(response, 429, { error: 'rate-limited' });
    return;
  }

  let session;
  if (sessionId !== undefined) {
    try {
      session = ctx.sessions.get(sessionId);
    } catch (error) {
      session = undefined;
    }
  }
  const context = recentContext(session);
  const signal = AbortSignal.timeout(REQUEST_BUDGET_MS);
  try {
    const raw = await generate(ctx, { mode, context, draft, language, signal });
    send(response, 200, { mode, text: tidy(raw, draft) });
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 200);
    console.warn(`composer-suggestion: ${mode} request failed: ${message}`);
    send(response, 200, { mode, text: '', error: message });
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (request, response) => {
      handle(ctx, request, response).catch((error) => {
        console.warn(`composer-suggestion: handler failed: ${String((error && error.message) || error)}`);
        try {
          send(response, 400, { error: 'handler-failed' });
        } catch (nested) {
          response.destroy();
        }
      });
    },
  }), 'composer-suggestion: suggestion route');
}

/** Pure helpers, exported for the test harness. */
export const __internals = { tidy, cutAtBoundary, requestAllowed, takeToken, recentContext, SECRET_PATTERN };
