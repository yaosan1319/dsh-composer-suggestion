window.__ModuleLoader__.load({
  id: 'dsh-composer-suggestion',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-composer-suggestion';
    const ROUTE = '/dsh-composer-suggestion/suggest';
    const DRAFT_LIMIT = 400;
    const MIN_ROOM_PX = 80;

    const ZH = { hint: '按 Tab 补全', dismiss: 'Esc 忽略', empty: '打开输入框后给建议' };
    const EN = { hint: 'Tab to complete', dismiss: 'Esc to dismiss', empty: 'Suggestions appear once you focus the composer' };

    /** Credential shapes that must never leave the composer. */
    const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*\S{8,})/iu;

    /** Full sentences the inline ghost can complete a half-typed draft into. */
    const ZH_PREFIX = [
      '继续，把剩下的步骤一次做完',
      '继续，接着上面的思路往下写',
      '帮我检查一下刚才的改动有没有问题',
      '帮我把这段代码改成 TypeScript 并补上类型',
      '帮我把上面的方案直接实现出来',
      '把上面的结论整理成一份清单',
      '把这段代码补上注释和单元测试',
      '把这一步拆成更小的步骤，一步步来',
      '解释一下这段代码的关键逻辑',
      '解释一下为什么要这样设计',
      '总结一下我们刚才做了什么',
      '再给我一个更简单的实现方案',
      '用中文重新说明一遍',
      '先跑一遍测试看看有没有报错',
      '顺便把文档也更新一下',
      '如果出错应该怎么回滚',
      '换一种写法，性能更好一点',
      '继续优化它的可读性',
      '把这个功能做成一个插件',
      '写一个最小可复现的例子',
      '列出还需要我确认的问题',
    ];

    const EN_PREFIX = [
      'Continue and finish the remaining steps in one pass',
      'Continue from where you left off',
      'Check the changes you just made for problems',
      'Rewrite this code in TypeScript and add types',
      'Implement the plan you just described',
      'Turn the conclusions above into a checklist',
      'Add comments and unit tests to this code',
      'Split this step into smaller steps',
      'Explain the key logic in this code',
      'Explain why it is designed this way',
      'Summarize what we just did',
      'Give me a simpler implementation',
      'Run the tests first and report any failure',
      'Update the documentation as well',
      'How do we roll back if something breaks',
      'Optimize it for readability',
      'Write a minimal reproduction example',
      'List the questions you still need me to answer',
    ];

    /** Offline recommendation pool used until the model answer arrives. */
    const ZH_RECOMMEND = [
      '继续，把剩下的部分做完',
      '把刚才的方案直接实现出来',
      '帮我检查一下有没有遗漏的边界情况',
      '跑一遍测试，然后告诉我结果',
      '总结一下这次改动的重点',
      '换成更简单的一种实现',
    ];

    const EN_RECOMMEND = [
      'Continue and finish the remaining work',
      'Implement the plan above',
      'Check for edge cases I might have missed',
      'Run the tests and report the results',
      'Summarize the key changes',
      'Give me a simpler approach',
    ];

    function hasCjk(text) {
      return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(String(text || ''));
    }

    function hasLatin(text) {
      return /[A-Za-z]/.test(String(text || ''));
    }

    /** Draft decides the wording language; the UI locale is only the fallback. */
    function resolveLanguage(draft, uiLanguage) {
      const text = String(draft || '');
      if (hasCjk(text)) return 'zh';
      if (hasLatin(text)) return 'en';
      return String(uiLanguage || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    function banksFor(language) {
      const zh = String(language || '').toLowerCase().startsWith('zh');
      return {
        sentences: zh ? ZH_PREFIX : EN_PREFIX,
        recommends: zh ? ZH_RECOMMEND : EN_RECOMMEND,
      };
    }

    function looksSecret(text) {
      return SECRET_PATTERN.test(String(text || ''));
    }

    /** Editor offsets may count code points; tolerate either coordinate system. */
    function codePointLength(text) {
      let length = 0;
      for (const _ of String(text || '')) length += 1;
      return length;
    }

    function hashOf(text) {
      let hash = 2166136261;
      const source = String(text === undefined || text === null ? '' : text);
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    function pick(pool, seed) {
      if (!pool || pool.length === 0) return null;
      const index = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) % pool.length : 0;
      return pool[index] || pool[0] || null;
    }

    /** Completion tail for a half-typed draft from the offline bank. */
    function completionTail(draft, banks) {
      const trimmed = String(draft || '').replace(/\s+$/u, '');
      if (!trimmed) return null;
      let best = null;
      for (const sentence of banks.sentences) {
        if (sentence.length <= trimmed.length) continue;
        if (!sentence.startsWith(trimmed)) continue;
        const tail = sentence.slice(trimmed.length);
        if (!best || tail.length < best.length) best = tail;
      }
      return best;
    }

    /** Bounded cache of model recommendations, keyed by session, language and mode. */
    const recommendCache = new Map();
    const RECOMMEND_TTL_MS = 45000;
    const RECOMMEND_CACHE_MAX = 32;

    function cacheGet(key) {
      const hit = recommendCache.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at >= RECOMMEND_TTL_MS) {
        recommendCache.delete(key);
        return null;
      }
      recommendCache.delete(key);
      recommendCache.set(key, hit);
      return hit;
    }

    function cacheSet(key, text) {
      recommendCache.delete(key);
      recommendCache.set(key, { text, at: Date.now() });
      while (recommendCache.size > RECOMMEND_CACHE_MAX) {
        const oldest = recommendCache.keys().next();
        if (oldest.done) break;
        recommendCache.delete(oldest.value);
      }
    }

    /**
     * One model suggestion from the Host route.
     * @returns a promise of text, or null when the Host has nothing to add.
     */
    async function requestSuggestion(payload, signal) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-composer-suggestion': '1',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data.text === 'string' && data.text.length > 0 ? data.text : null;
    }

    function readCaretRect() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect && (rect.height > 0 || rect.width > 0)) return rect;
      const rects = range.getClientRects();
      if (rects && rects.length > 0) return rects[rects.length - 1];
      return null;
    }

    /** First-line caret position for an empty paragraph, where a range reports no box. */
    function fallbackCaretRect(element, style) {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return null;
      const paddingLeft = parseFloat(style ? style.paddingLeft : '') || 0;
      const paddingTop = parseFloat(style ? style.paddingTop : '') || 0;
      let lineHeight = parseFloat(style ? style.lineHeight : '');
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        lineHeight = (parseFloat(style ? style.fontSize : '') || 16) * 1.5;
      }
      return { left: box.left + paddingLeft, top: box.top + paddingTop, height: lineHeight, width: 0, right: box.left + paddingLeft };
    }

    /** The focused draft editor, but only while its own selection is inside it. */
    function focusedEditor() {
      const active = document.activeElement;
      if (!active || !active.isContentEditable) return null;
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (!range) return null;
      if (active !== range.startContainer && !active.contains(range.startContainer)) return null;
      return active;
    }

    /**
     * Insert text at the caret.
     * @returns true only when the draft really changed, so the caller can decide
     * whether to consume the key event.
     */
    function insertAtCaret(inputActions, text, draft) {
      if (!inputActions || !text) return false;
      let span = null;
      try {
        span = inputActions.captureInsertion();
      } catch (error) {
        return false;
      }
      if (!span || span.start !== span.end) return false;
      const length = String(draft || '').length;
      if (span.end !== length && span.end !== codePointLength(draft)) return false;
      let result;
      try {
        result = inputActions.insertText(text, span);
      } catch (error) {
        return false;
      }
      // A void return means the API accepted the edit; only an explicit false is a refusal.
      return result !== false;
    }

    const BADGE = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 5px',
      height: '16px',
      borderRadius: '4px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.14))',
      color: 'var(--dsw-alias-label-tertiary, #8b8f96)',
      fontSize: '10px',
      lineHeight: '14px',
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      flex: '0 0 auto',
    };

    /** Composer state plus whether the draft editor currently owns focus. */
    function useComposerState(props) {
      const { useInput } = props;
      const draft = useInput ? useInput((state) => state.draft) : '';
      const revision = useInput ? useInput((state) => state.draftRev) : 0;
      const phase = useInput ? useInput((state) => state.phase) : 'plain';
      const uiLanguage = (props.getLanguage && props.getLanguage()) || 'en';
      const language = resolveLanguage(draft, uiLanguage);
      const banks = useMemo(() => banksFor(language), [language]);
      const blocked = phase === 'submitting' || phase === 'adjudicating';

      const [focused, setFocused] = useState(false);
      // Auto-focus on session open must not count as engagement, otherwise the
      // transcript is sent to the model before the user ever touches the composer.
      const [engaged, setEngaged] = useState(false);
      const [imeEpoch, setImeEpoch] = useState(0);
      const composing = useRef(false);

      useEffect(() => {
        const onFocusIn = (event) => {
          const target = event.target;
          if (target && target.isContentEditable) setFocused(true);
        };
        const onFocusOut = () => setFocused(false);
        // Engagement requires a real interaction whose target is the draft editor:
        // a sidebar click, an auto-focus, or a press elsewhere never qualifies.
        const onPointerDown = (event) => {
          const target = event.target;
          const editor = target && target.closest ? target.closest('[contenteditable="true"]') : null;
          if (editor && editor.isContentEditable) setEngaged(true);
        };
        const onKeyDown = (event) => {
          const target = event.target;
          if (target && target.isContentEditable) setEngaged(true);
        };
        const onCompositionStart = () => {
          composing.current = true;
        };
        const onCompositionEnd = () => {
          composing.current = false;
          setImeEpoch((value) => value + 1);
        };
        document.addEventListener('focusin', onFocusIn, true);
        document.addEventListener('focusout', onFocusOut, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('compositionstart', onCompositionStart, true);
        document.addEventListener('compositionend', onCompositionEnd, true);
        setFocused(focusedEditor() !== null);
        return () => {
          document.removeEventListener('focusin', onFocusIn, true);
          document.removeEventListener('focusout', onFocusOut, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('compositionstart', onCompositionStart, true);
          document.removeEventListener('compositionend', onCompositionEnd, true);
        };
      }, []);


      return { draft, revision, language, banks, blocked, focused, engaged, imeEpoch, composing };
    }

    /** Ask the Host for a model suggestion once the draft has been idle for a moment. */
    function useModelSuggestion({ props, draft, revision, language, blocked, focused, engaged, imeEpoch, composing, mode, idleMs }) {
      const [state, setState] = useState(null);
      const draftRef = useRef(draft);
      draftRef.current = draft;

      useEffect(() => {
        if (blocked || !engaged) return undefined;
        if (composing && composing.current) return undefined;
        if (mode === 'continuation' && String(draft || '').trim().length === 0) return undefined;
        if (mode === 'recommend' && String(draft || '') !== '') return undefined;
        const cacheKey = `${props.sessionId || 'none'}:${language}:${mode}`;
        if (mode === 'recommend') {
          const hit = cacheGet(cacheKey);
          if (hit) {
            setState({ draft: String(draft || ''), text: hit.text });
            return undefined;
          }
        }
        const controller = new AbortController();
        let cancelled = false;
        const timer = setTimeout(() => {
          const sent = String(draft || '').slice(0, DRAFT_LIMIT);
          if (looksSecret(sent)) return;
          requestSuggestion({
            mode,
            draft: sent,
            language,
            sessionId: props.sessionId,
          }, controller.signal).then((text) => {
            if (cancelled || !text) return;
            // Discard an answer that no longer matches what the user is typing.
            if (String(draftRef.current || '').slice(0, DRAFT_LIMIT) !== sent) return;
            if (mode === 'recommend') cacheSet(cacheKey, text);
            setState({ draft: String(draftRef.current || ''), text });
          }, () => {});
        }, idleMs);
        return () => {
          cancelled = true;
          clearTimeout(timer);
          controller.abort();
        };
      }, [draft, revision, language, blocked, focused, engaged, imeEpoch, mode, idleMs, props.sessionId, composing]);

      return state;
    }

    /** Inline ghost completion appended at the caret of a non-empty draft. */
    function ComposerSuggestion(props) {
      const { inputActions } = props;
      const state = useComposerState(props);
      const { draft, revision, language, banks, blocked, focused, engaged } = state;
      const [tail, setTail] = useState(null);
      const [layout, setLayout] = useState(null);

      const ghostRef = useRef(null);
      const tailRef = useRef(null);
      const draftRef = useRef(draft);
      const dismissedRef = useRef(null);

      draftRef.current = draft;
      tailRef.current = tail;

      const model = useModelSuggestion({
        props, draft, revision, language, blocked, focused, engaged,
        imeEpoch: state.imeEpoch, composing: state.composing,
        mode: 'continuation',
        idleMs: 700,
      });

      const measure = useCallback(() => {
        const ghost = ghostRef.current;
        if (!ghost) {
          setLayout(null);
          return;
        }
        const editor = focusedEditor();
        if (!editor) {
          setLayout(null);
          return;
        }
        const style = window.getComputedStyle(editor);
        const caret = readCaretRect() || fallbackCaretRect(editor, style);
        if (!caret) {
          setLayout(null);
          return;
        }
        let span = null;
        try {
          span = inputActions ? inputActions.captureInsertion() : null;
        } catch (error) {
          span = null;
        }
        const draftText = String(draftRef.current || '');
        if (span && (span.start !== span.end
          || (span.end !== draftText.length && span.end !== codePointLength(draftText)))) {
          setLayout(null);
          return;
        }
        // Truncate inside the card instead of sliding left over the typed text.
        const editorBox = editor.getBoundingClientRect();
        const right = editorBox.right;
        const room = Math.floor(right - caret.left);
        if (!Number.isFinite(room) || room < MIN_ROOM_PX) {
          setLayout(null);
          return;
        }
        const previous = ghost.style.transform;
        ghost.style.transform = 'translate(0px, 0px)';
        const box = ghost.getBoundingClientRect();
        ghost.style.transform = previous;
        if (!box || box.width <= 0) {
          setLayout(null);
          return;
        }
        const dx = caret.left - box.left;
        const dy = caret.top + (caret.height - box.height) / 2 - box.top;
        setLayout({
          dx,
          dy,
          room,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        });
      }, [inputActions]);

      /** @returns true only when the suggestion really landed in the draft. */
      const accept = useCallback(() => {
        const text = tailRef.current;
        if (!text) return false;
        const draftNow = String(draftRef.current || '');
        const landed = insertAtCaret(inputActions, text, draftNow);
        if (!landed) return false;
        dismissedRef.current = draftNow + text;
        tailRef.current = null;
        setTail(null);
        setLayout(null);
        return true;
      }, [inputActions]);

      useEffect(() => {
        if (blocked || !engaged || !focused || draft === dismissedRef.current) {
          setTail(null);
          setLayout(null);
          return;
        }
        const trimmed = String(draft || '').replace(/\s+$/u, '');
        if (!trimmed || looksSecret(trimmed)) {
          setTail(null);
          return;
        }
        let next = null;
        if (model && model.draft === draft) {
          next = (model.text.startsWith(trimmed) ? model.text.slice(trimmed.length) : model.text).replace(/^\s+/u, '');
        }
        if (!next) next = completionTail(draft, banks);
        setTail(next && next.length > 0 ? next : null);
      }, [draft, revision, banks, blocked, model, focused, engaged]);

      useEffect(() => {
        if (!tail) {
          setLayout(null);
          return;
        }
        let frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(measure);
        });
        const timers = [setTimeout(measure, 150), setTimeout(measure, 400)];
        return () => {
          cancelAnimationFrame(frame);
          for (const timer of timers) clearTimeout(timer);
        };
      }, [tail, measure]);

      useEffect(() => {
        if (!tail) return undefined;
        let pending = 0;
        const schedule = () => {
          if (pending) return;
          pending = requestAnimationFrame(() => {
            pending = 0;
            measure();
          });
        };
        document.addEventListener('selectionchange', schedule);
        document.addEventListener('focusin', schedule, true);
        document.addEventListener('focusout', schedule, true);
        document.addEventListener('pointerup', schedule, true);
        document.addEventListener('keyup', schedule, true);
        window.addEventListener('scroll', schedule, true);
        window.addEventListener('resize', schedule);
        return () => {
          if (pending) cancelAnimationFrame(pending);
          document.removeEventListener('selectionchange', schedule);
          document.removeEventListener('focusin', schedule, true);
          document.removeEventListener('focusout', schedule, true);
          document.removeEventListener('pointerup', schedule, true);
          document.removeEventListener('keyup', schedule, true);
          window.removeEventListener('scroll', schedule, true);
          window.removeEventListener('resize', schedule);
        };
      }, [tail, measure]);

      useEffect(() => {
        if (!tail) return undefined;
        const onKeyDown = (event) => {
          if (!tailRef.current) return;
          if (!focusedEditor()) return;
          if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
            // Consume the key only when the ghost actually landed; otherwise the
            // user keeps native Tab behaviour instead of a dead key.
            if (accept()) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (event.key === 'Escape') {
            dismissedRef.current = draftRef.current;
            tailRef.current = null;
            setTail(null);
            setLayout(null);
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [tail, accept]);

      return h('span', {
        'aria-hidden': true,
        'data-composer-suggestion': '',
        style: { position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' },
      }, tail === null ? null : h('span', {
        ref: ghostRef,
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          maxWidth: layout ? `${layout.room}px` : '70vw',
          overflow: 'hidden',
          whiteSpace: 'pre',
          pointerEvents: 'none',
          userSelect: 'none',
          color: 'var(--dsw-alias-label-tertiary, #8b8f96)',
          fontFamily: layout ? layout.fontFamily : undefined,
          fontSize: layout ? layout.fontSize : undefined,
          lineHeight: layout ? layout.lineHeight : undefined,
          transform: layout ? `translate(${layout.dx}px, ${layout.dy}px)` : 'translate(0px, 0px)',
          visibility: layout ? 'visible' : 'hidden',
        },
      }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'pre' } }, tail),
      h('span', { style: BADGE }, 'Tab')));
    }

    /** Suggested continuation prompt offered under the card while the draft is empty. */
    function ComposerSuggestionDock(props) {
      const { inputActions } = props;
      const state = useComposerState(props);
      const { draft, revision, language, banks, blocked, focused, engaged } = state;
      const [recommend, setRecommend] = useState(null);
      const recommendRef = useRef(null);
      const dismissRef = useRef(null);
      const draftRef = useRef(draft);
      draftRef.current = draft;
      recommendRef.current = recommend;

      const model = useModelSuggestion({
        props, draft, revision, language, blocked, focused, engaged,
        imeEpoch: state.imeEpoch, composing: state.composing,
        mode: 'recommend',
        idleMs: 300,
      });

      useEffect(() => {
        // Nothing is requested, and nothing is shown, before the user touches the composer.
        if (blocked || !engaged || !focused || draft !== '') {
          setRecommend(null);
          return;
        }
        if (dismissRef.current !== null && dismissRef.current === revision) {
          setRecommend(null);
          return;
        }
        if (model) {
          setRecommend(model.text);
          return;
        }
        const base = Number.isFinite(revision) ? revision : 0;
        setRecommend(pick(banks.recommends, hashOf(`${props.sessionId}:${language}`) + base));
      }, [draft, revision, banks, blocked, model, props.sessionId, focused, engaged, language]);

      const accept = useCallback(() => {
        const text = recommendRef.current;
        if (!text) return false;
        if (!insertAtCaret(inputActions, text, draftRef.current)) return false;
        recommendRef.current = null;
        setRecommend(null);
        return true;
      }, [inputActions]);

      useEffect(() => {
        if (!recommend) return undefined;
        const onKeyDown = (event) => {
          if (!recommendRef.current) return;
          if (!focusedEditor()) return;
          if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
            if (accept()) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (event.key === 'Escape') {
            dismissRef.current = revision;
            recommendRef.current = null;
            setRecommend(null);
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [recommend, accept, revision]);

      if (!recommend) return null;

      return h('div', {
        style: { display: 'flex', justifyContent: 'flex-start', padding: '2px 2px 0' },
      }, h('button', {
        type: 'button',
        'data-composer-suggestion-hint': '',
        title: props.t ? props.t('hint') : undefined,
        onMouseDown: (event) => {
          // Keep the caret and selection in the editor.
          event.preventDefault();
        },
        onClick: accept,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          maxWidth: '100%',
          padding: '3px 8px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
          color: 'var(--dsw-alias-label-secondary, #6b7076)',
          fontSize: '12px',
          lineHeight: '16px',
          cursor: 'pointer',
          font: 'inherit',
        },
      }, h('span', {
        style: { color: 'var(--dsw-alias-label-tertiary, #8b8f96)' },
      }, '↳'), h('span', {
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, recommend), h('span', { style: BADGE }, 'Tab')));
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }));
      const getLanguage = () => {
        try {
          const snapshot = ctx.locale.getLocale();
          return (snapshot && (snapshot.active || snapshot.id)) || 'en';
        } catch (error) {
          return 'en';
        }
      };
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'composer-suggestion',
        order: 10,
        locale: NS,
        inject: () => ({ getLanguage }),
      }, ComposerSuggestion));
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'composer-suggestion-hint',
        order: 10,
        locale: NS,
        inject: () => ({ getLanguage }),
      }, ComposerSuggestionDock));
    }

    return {
      inject,
      apply,
      __internals: {
        banksFor,
        completionTail,
        insertAtCaret,
        looksSecret,
        hasCjk,
        resolveLanguage,
        codePointLength,
        cacheGet,
        cacheSet,
        pick,
        hashOf,
        MIN_ROOM_PX,
      },
    };
  },
});
