'use client';

import type { ResumeTree } from '@sailor/core';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chat, type ChatItem, reduceEvent } from '../../../components/chat.tsx';
import { Editor } from '../../../components/editor.tsx';
import { Sheet } from '../../../components/sheet.tsx';
import { AcpClient, type ElicitAsk, type PermissionAsk } from '../../../lib/acp-client.ts';
import { api, type ProviderInfo } from '../../../lib/api.ts';
import { usePreview } from '../../../lib/use-preview.ts';

type JobDraft = {
  company: string;
  role: string;
  description: string;
  sourceUrl: string;
};

const EMPTY_JOB_DRAFT: JobDraft = {
  company: '',
  role: '',
  description: '',
  sourceUrl: '',
};

export default function Workbench() {
  const params = useParams<{ id: string }>();
  const resumeId = params.id;

  const [tree, setTree] = useState<ResumeTree | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [model, setModel] = useState<string>('');
  const [jobTarget, setJobTarget] = useState<{ id: string; company: string; role: string } | null>(
    null,
  );
  const [jobDialogOpen, setJobDialogOpen] = useState(false);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [permission, setPermission] = useState<PermissionAsk | null>(null);
  const [elicit, setElicit] = useState<ElicitAsk | null>(null);

  const clientRef = useRef<AcpClient | null>(null);
  const sessionRef = useRef<string | null>(null);

  const preview = usePreview(tree);

  const entryFile = useMemo(() => tree?.files.find((f) => f.path === tree.entry) ?? null, [tree]);

  /** Pull the tip from the server. Called on mount and whenever the agent commits. */
  const reload = useCallback(async () => {
    const { version } = await api.getResume(resumeId);
    setTree(version.tree);
    setVersionId(version.id);
    setDirty(false);
  }, [resumeId]);

  useEffect(() => {
    void reload();
    void api.models().then((r) => {
      setProviders(r.providers);
      const firstAvailable = r.providers.find((p) => p.available);
      const firstModel = firstAvailable?.models[0];
      if (firstAvailable && firstModel) {
        setModel(`${firstAvailable.id}:${firstModel.modelId}`);
      }
    });
  }, [reload]);

  // --- ACP -----------------------------------------------------------------

  useEffect(() => {
    const client = new AcpClient({
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onEvent: (event) => {
        setItems((prev) => reduceEvent(prev, event));

        // The agent changed the document. Reload so the editor and the sheet show
        // what was actually saved, rather than the user's stale buffer.
        if (event.type === 'version_committed') void reload();
        if (event.type === 'turn_end') setBusy(false);
      },
      onPermission: (ask) =>
        setPermission({
          ...ask,
          respond: (outcome) => {
            ask.respond(outcome);
            setPermission(null);
          },
        }),
      onElicit: (ask) =>
        setElicit({
          ...ask,
          respond: (answer) => {
            ask.respond(answer);
            setElicit(null);
          },
        }),
    });

    client.connect();
    clientRef.current = client;
    return () => client.close();
  }, [reload]);

  const send = useCallback(
    async (text: string) => {
      const client = clientRef.current;
      if (!client || !model) return;

      setItems((prev) => [...prev, { kind: 'user', text }]);
      setBusy(true);

      try {
        if (!sessionRef.current) {
          await client.initialize();
          const { sessionId } = await client.newSession(resumeId, model, jobTarget?.id ?? null);
          sessionRef.current = sessionId;
        }
        await client.prompt(sessionRef.current, text);
      } catch (cause) {
        setItems((prev) => [
          ...prev,
          {
            kind: 'error',
            message: cause instanceof Error ? cause.message : 'The turn failed',
          },
        ]);
        setBusy(false);
      }
    },
    [jobTarget?.id, model, resumeId],
  );

  const cancel = useCallback(() => {
    if (sessionRef.current) clientRef.current?.cancel(sessionRef.current);
    setBusy(false);
  }, []);

  // --- Editing -------------------------------------------------------------

  const onEdit = useCallback((next: string) => {
    setTree((current) => {
      if (!current) return current;
      return {
        entry: current.entry,
        files: current.files.map((f) => (f.path === current.entry ? { ...f, content: next } : f)),
      };
    });
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!tree || !dirty) return;
    setSaving(true);
    try {
      const result = await api.saveVersion(resumeId, tree, 'Manual edit', versionId);
      setVersionId(result.versionId);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [tree, dirty, resumeId, versionId]);

  // ⌘S saves. Muscle memory in an editor is not optional.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const noProviders = providers.length > 0 && !providers.some((p) => p.available);

  const createJobTarget = useCallback(async (draft: JobDraft) => {
    const { jobTargetId } = await api.createJob({
      company: draft.company.trim(),
      role: draft.role.trim(),
      description: draft.description.trim(),
      sourceUrl: draft.sourceUrl.trim() || null,
    });
    setJobTarget({
      id: jobTargetId,
      company: draft.company.trim(),
      role: draft.role.trim(),
    });
    // ACP sessions are tied to one job target. Do not keep a session that was
    // created for a different target and quietly send the next turn to it.
    sessionRef.current = null;
    setItems([]);
    setJobDialogOpen(false);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <header className="rule-b flex shrink-0 items-center justify-between px-4 py-2.5">
        <div className="flex items-baseline gap-4">
          <Link
            href="/"
            className="text-[17px] text-chalk-100 hover:text-ochre"
            style={{ fontFamily: 'var(--font-display)', fontWeight: 500 }}
          >
            Sailor
          </Link>
          <span className="font-mono text-[11px] text-ink-500">
            {dirty ? 'unsaved' : saving ? 'saving…' : 'saved'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="border border-ink-700 bg-ink-850 px-2 py-1.5 font-mono text-[11px] text-chalk-300"
          >
            {providers.flatMap((provider) =>
              provider.models.map((m) => (
                <option
                  key={`${provider.id}:${m.modelId}`}
                  value={`${provider.id}:${m.modelId}`}
                  disabled={!provider.available}
                >
                  {m.label}
                  {provider.available ? '' : ' — no key'}
                </option>
              )),
            )}
          </select>

          <button
            type="button"
            onClick={() => setJobDialogOpen(true)}
            className="max-w-52 truncate border border-ink-600 px-3 py-1.5 font-mono text-[11px] text-chalk-300 hover:border-ochre hover:text-chalk-100"
            title={jobTarget ? `${jobTarget.company} — ${jobTarget.role}` : 'Set a job target'}
          >
            {jobTarget ? `${jobTarget.company} · ${jobTarget.role}` : 'Set target'}
          </button>

          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="border border-ink-600 px-3 py-1.5 font-mono text-[11px] text-chalk-300 hover:border-ink-500 disabled:opacity-30"
          >
            Save
          </button>

          {versionId && (
            <a
              href={api.downloadUrl(versionId)}
              className="bg-ochre px-3 py-1.5 font-mono text-[11px] font-medium text-ink-900 hover:opacity-90"
            >
              PDF
            </a>
          )}
        </div>
      </header>

      {noProviders && (
        <div className="shrink-0 border-b border-ochre/40 bg-ochre/[0.06] px-4 py-2">
          <p className="text-[12.5px] text-ochre">
            No model provider is configured — the agent cannot run. Add an API key to{' '}
            <code className="font-mono">.env</code> (any of{' '}
            <code className="font-mono">ANTHROPIC_API_KEY</code>,{' '}
            <code className="font-mono">OPENAI_API_KEY</code>,{' '}
            <code className="font-mono">GOOGLE_GENERATIVE_AI_API_KEY</code>,{' '}
            <code className="font-mono">OPENROUTER_API_KEY</code>) and restart the API. Editing and
            preview work regardless.
          </p>
        </div>
      )}

      {jobDialogOpen && (
        <JobTargetDialog
          initial={EMPTY_JOB_DRAFT}
          onClose={() => setJobDialogOpen(false)}
          onCreate={createJobTarget}
        />
      )}

      <main className="grid min-h-0 flex-1 grid-cols-[1fr_1fr_400px]">
        <section className="rule-r flex min-h-0 flex-col">
          <header className="rule-b flex items-center justify-between px-4 py-2.5">
            <span className="font-mono text-[11px] tracking-widest text-ink-500 uppercase">
              {tree?.entry ?? 'source'}
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            {entryFile && <Editor value={entryFile.content} onChange={onEdit} />}
          </div>
        </section>

        <section className="rule-r min-h-0">
          <Sheet state={preview} />
        </section>

        <section className="min-h-0">
          <Chat
            items={items}
            busy={busy}
            connected={connected}
            permission={permission}
            elicit={elicit}
            onSend={send}
            onCancel={cancel}
          />
        </section>
      </main>
    </div>
  );
}

function JobTargetDialog({
  initial,
  onClose,
  onCreate,
}: {
  initial: JobDraft;
  onClose: () => void;
  onCreate: (draft: JobDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (field: keyof JobDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the job target.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-ink-900/85 p-4 backdrop-blur-sm"
    >
      <form
        onSubmit={submit}
        aria-labelledby="job-target-title"
        className="w-full max-w-2xl border border-ink-600 bg-ink-850 shadow-2xl shadow-black/50"
      >
        <header className="rule-b flex items-start justify-between gap-6 px-5 py-4">
          <div>
            <p className="font-mono text-[10.5px] tracking-[0.18em] text-ochre uppercase">
              Tailoring brief
            </p>
            <h2 id="job-target-title" className="mt-1 text-[19px] text-chalk-100">
              Set the target job
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              Give the agent the actual description. It can reframe supported experience, never
              manufacture it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] text-ink-500 hover:text-chalk-300"
          >
            Close
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Company"
              value={draft.company}
              onChange={(value) => update('company', value)}
            />
            <Field label="Role" value={draft.role} onChange={(value) => update('role', value)} />
          </div>

          <Field
            label="Posting URL (optional)"
            value={draft.sourceUrl}
            onChange={(value) => update('sourceUrl', value)}
            type="url"
            placeholder="https://company.com/careers/..."
          />

          <label className="block">
            <span className="font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">
              Job description
            </span>
            <textarea
              value={draft.description}
              onChange={(event) => update('description', event.target.value)}
              required
              minLength={20}
              rows={10}
              placeholder="Paste the full role description, requirements, and responsibilities."
              className="mt-1.5 block w-full resize-y border border-ink-600 bg-ink-900 px-3 py-2.5 text-[13px] leading-relaxed text-chalk-100 placeholder:text-ink-500 focus:border-ochre focus:outline-none"
            />
          </label>

          {error && (
            <p className="border-l-2 border-strike pl-3 text-[12.5px] text-strike">{error}</p>
          )}
        </div>

        <footer className="rule-b flex items-center justify-between gap-4 border-t border-ink-700 px-5 py-4">
          <p className="max-w-md text-[11.5px] leading-relaxed text-ink-500">
            Changing the target starts a fresh agent session, so its job context stays explicit.
          </p>
          <button
            type="submit"
            disabled={
              submitting ||
              !draft.company.trim() ||
              !draft.role.trim() ||
              draft.description.trim().length < 20
            }
            className="shrink-0 bg-ochre px-4 py-2 font-mono text-[11px] font-medium text-ink-900 hover:opacity-90 disabled:opacity-30"
          >
            {submitting ? 'Saving…' : 'Use this target'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'url';
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={label !== 'Posting URL (optional)'}
        placeholder={placeholder}
        className="mt-1.5 block w-full border border-ink-600 bg-ink-900 px-3 py-2.5 text-[13px] text-chalk-100 placeholder:text-ink-500 focus:border-ochre focus:outline-none"
      />
    </label>
  );
}
