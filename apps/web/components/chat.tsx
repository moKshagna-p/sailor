'use client';

import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AgentEvent, ElicitAsk, GapAnalysis, PermissionAsk } from '../lib/acp-client.ts';
import { DiffView } from './diff-view.tsx';

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'tool'; name: string; ok: boolean | null; detail: string }
  | { kind: 'gap'; analysis: GapAnalysis }
  | { kind: 'committed'; summary: string }
  | { kind: 'error'; message: string };

const TOOL_LABELS: Record<string, string> = {
  read_resume: 'Reading the résumé',
  edit_resume: 'Editing',
  compile_resume: 'Compiling',
  web_search: 'Searching the web',
  fetch_url: 'Reading',
  ask_user: 'Asking you',
  record_gap_analysis: 'Analysing the gap',
};

/**
 * Drafting a question about a selection is a command, not app state: the same
 * selection must be able to refill and focus the composer more than once.
 */
export type ChatHandle = { setDraft: (text: string) => void };

export function Chat({
  items,
  busy,
  connected,
  permission,
  elicit,
  onSend,
  onCancel,
  ref,
}: {
  items: ChatItem[];
  busy: boolean;
  connected: boolean;
  permission: PermissionAsk | null;
  elicit: ElicitAsk | null;
  onSend: (text: string) => void;
  onCancel: () => void;
  ref?: Ref<ChatHandle>;
}) {
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    setDraft(text) {
      setDraft(text);
      const input = draftRef.current;
      input?.focus();
      input?.setSelectionRange(text.length, text.length);
    },
  }));

  // Scroll to the bottom whenever anything new appears. The deps are the *triggers*
  // for scrolling, not values the effect reads — biome cannot tell the difference.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are scroll triggers
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [items.length, permission, elicit]);

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <header className="rule-b flex items-center justify-between px-4 py-2.5">
        <span className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">Agent</span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-500">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              connected ? 'bg-added' : 'bg-strike'
            }`}
          />
          {connected ? 'connected' : 'offline'}
        </span>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
        {items.length === 0 && !permission && !elicit && (
          <div className="pt-6">
            <p className="text-[13px] leading-relaxed text-ink-500">
              Paste a job posting URL, or tell me the company and role. I'll read the actual
              posting, show you where your résumé is thin, and propose edits one at a time.
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-500">
              I won't add a number you didn't give me. If a bullet needs one, I'll ask.
            </p>
          </div>
        )}

        {/* The transcript is strictly append-only — a row's index never changes
            once it exists, so the index IS its stable identity here. */}
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
          <ChatRow key={i} item={item} />
        ))}

        {busy && !permission && !elicit && (
          <p className="breathe font-mono text-[11px] text-ochre">working…</p>
        )}
      </div>

      {permission && <PermissionPrompt ask={permission} />}

      {elicit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            elicit.respond(answer);
            setAnswer('');
          }}
          className="border-t border-ochre/40 bg-ochre/[0.06] px-4 py-4"
        >
          <p className="whitespace-pre-line text-[13px] leading-relaxed text-chalk-100">
            {elicit.question}
          </p>
          <div className="mt-3 flex gap-2">
            <input
              // The agent is BLOCKED on this answer — a tool call upstream is
              // literally awaiting it. Focusing the field is correct here; the
              // a11y concern is about stealing focus unprompted, which this is not.
              // biome-ignore lint/a11y/noAutofocus: the agent is blocked on this input
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Your answer — or leave blank if you'd rather not say"
              className="flex-1 border border-ink-600 bg-ink-900 px-3 py-2 text-[13px] text-chalk-100 placeholder:text-ink-500"
            />
            <button
              type="submit"
              className="bg-ochre px-4 py-2 text-[13px] font-medium text-ink-900 hover:opacity-90"
            >
              Answer
            </button>
          </div>
          <p className="mt-2 font-mono text-[10.5px] text-ink-500">
            Leave it blank and the agent will write the bullet without the number, not guess one.
          </p>
        </form>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim() || busy) return;
          onSend(draft.trim());
          setDraft('');
        }}
        className="rule-b border-t border-ink-700 p-3"
      >
        <div className="flex gap-2">
          <input
            ref={draftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!connected}
            placeholder={connected ? 'Tailor this for…' : 'Connecting…'}
            className="flex-1 border border-ink-700 bg-ink-850 px-3 py-2.5 text-[13px] text-chalk-100 placeholder:text-ink-500 focus:border-ink-600"
          />
          {busy ? (
            <button
              type="button"
              onClick={onCancel}
              className="border border-ink-600 px-4 py-2.5 text-[13px] text-chalk-300 hover:border-strike hover:text-strike"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!connected || !draft.trim()}
              className="bg-ochre px-4 py-2.5 text-[13px] font-medium text-ink-900 hover:opacity-90 disabled:opacity-30"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * The gate. It shows the *diff*, not a vague "the agent wants to edit your
 * résumé" — a permission prompt the user cannot evaluate is just a speed bump
 * that teaches them to click Allow without reading.
 */
function PermissionPrompt({ ask }: { ask: PermissionAsk }) {
  return (
    <div className="rise border-t border-ochre/40 bg-ochre/[0.06] px-4 py-4">
      <p className="font-mono text-[11px] tracking-widest text-ochre uppercase">
        Approve this edit
      </p>
      <p className="mt-1.5 text-[13px] text-chalk-100">{ask.title}</p>

      {ask.diff && (
        <div className="mt-3">
          <DiffView diff={ask.diff} />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          // Same reasoning: the turn is halted until the human answers.
          // biome-ignore lint/a11y/noAutofocus: the agent is blocked on this decision
          autoFocus
          onClick={() => ask.respond('allow')}
          className="bg-ochre px-4 py-2 text-[13px] font-medium text-ink-900 hover:opacity-90"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={() => ask.respond('deny')}
          className="border border-ink-600 px-4 py-2 text-[13px] text-chalk-300 hover:border-strike hover:text-strike"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="border-l-2 border-ink-600 pl-3">
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-chalk-100">
          {item.text}
        </p>
      </div>
    );
  }

  if (item.kind === 'agent') {
    return (
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-chalk-300">{item.text}</p>
    );
  }

  if (item.kind === 'tool') {
    const label = TOOL_LABELS[item.name] ?? item.name;
    return (
      <p className="flex items-center gap-2 font-mono text-[11px] text-ink-500">
        <span className={item.ok === null ? 'text-ochre' : item.ok ? 'text-added' : 'text-strike'}>
          {item.ok === null ? '○' : item.ok ? '●' : '✕'}
        </span>
        {label}
        {item.detail && <span className="truncate text-ink-600">{item.detail}</span>}
      </p>
    );
  }

  if (item.kind === 'committed') {
    return (
      <p className="border-l-2 border-added py-0.5 pl-3 font-mono text-[11px] text-added">
        saved · {item.summary}
      </p>
    );
  }

  if (item.kind === 'error') {
    return (
      <p className="border-l-2 border-strike py-0.5 pl-3 text-[12.5px] text-strike">
        {item.message}
      </p>
    );
  }

  return <GapCard analysis={item.analysis} />;
}

function GapCard({ analysis }: { analysis: GapAnalysis }) {
  const colour = {
    strong: 'text-added',
    weak: 'text-ochre',
    missing: 'text-strike',
  } as const;

  return (
    <div className="rise border border-ink-700 bg-ink-850 p-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">
          Gap analysis
        </span>
        <span className="font-mono text-[11px] text-chalk-300">{analysis.coverage}% covered</span>
      </div>

      <ul className="mt-3 space-y-2">
        {analysis.matches.map((match) => (
          <li key={match.requirement} className="text-[12.5px] leading-relaxed">
            <span className={`font-mono text-[10px] uppercase ${colour[match.status]}`}>
              {match.status}
            </span>{' '}
            <span className="text-chalk-300">{match.requirement}</span>
            {match.askUser && (
              <p className="mt-0.5 pl-2 text-[11.5px] text-ochre italic">→ {match.askUser}</p>
            )}
          </li>
        ))}
      </ul>

      {analysis.notes && (
        <p className="mt-3 border-t border-ink-700 pt-2 text-[12.5px] leading-relaxed text-chalk-400">
          {analysis.notes}
        </p>
      )}
    </div>
  );
}

/** Folds the agent's event stream into the flat list the panel renders. */
export function reduceEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  const next = [...items];
  const last = next[next.length - 1];

  switch (event.type) {
    case 'text_delta':
      // Coalesce deltas into the trailing agent bubble rather than one per token.
      if (last?.kind === 'agent') {
        next[next.length - 1] = { kind: 'agent', text: last.text + event.text };
      } else {
        next.push({ kind: 'agent', text: event.text });
      }
      return next;

    case 'tool_start':
      next.push({
        kind: 'tool',
        name: event.name,
        ok: null,
        detail: describe(event.input),
      });
      return next;

    case 'tool_end': {
      // Close out the matching pending row.
      for (let i = next.length - 1; i >= 0; i--) {
        const row = next[i];
        if (row?.kind === 'tool' && row.name === event.name && row.ok === null) {
          next[i] = { ...row, ok: event.ok };
          break;
        }
      }
      return next;
    }

    case 'gap_analysis':
      next.push({ kind: 'gap', analysis: event.analysis });
      return next;

    case 'version_committed':
      next.push({ kind: 'committed', summary: event.summary });
      return next;

    case 'error':
      next.push({ kind: 'error', message: event.message });
      return next;

    default:
      return next;
  }
}

function describe(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  const value = record.query ?? record.url ?? record.summary ?? record.path;
  return typeof value === 'string' ? value.slice(0, 48) : '';
}
