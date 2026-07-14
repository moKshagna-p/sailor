# Resume agent and ACP

The agent is a bounded AI SDK 7 tool loop in `packages/agent`. It receives the
current immutable resume version and, when selected, a job target. The system
prompt instructs it to work only from resume evidence and user-provided facts:
missing metrics, technologies, dates, titles, and employers are questions, not
opportunities to guess.

## A turn

`runTurn()` streams one turn with a 40-step ceiling. It emits text, reasoning,
tool progress, gap analysis, errors, and a final stop reason. The API persists
the model messages after a successful turn so a browser refresh can rehydrate
the ACP session and preserve context.

The job target carries its provenance. Text pasted by a user is labelled
`pasted`; only a posting that the agent fetched itself is `fetched`. The prompt
uses that distinction when judging how much it can trust the description.

## Tools and permissions

Tools live in `packages/agent/src/tools/` and are assembled once by
`buildTools()`. That registry powers both the in-process loop and MCP server;
never create parallel tool definitions.

- `read_resume` and `compile_resume` inspect a document.
- `fetch_url` and `web_search` research a job or company. Public URL validation
  rejects localhost, private IPv4 ranges, link-local metadata endpoints, and
  non-HTTP(S) URLs.
- `record_gap_analysis` records the evidence-backed requirements comparison.
- `ask_user` asks for a missing fact and waits for an answer.
- `edit_resume` is the only content mutation path and is gated.

Before `edit_resume` runs, the API sends an ACP
`session/request_permission` request containing a diff. The browser must answer
allow or deny. A disconnect is treated as deny. Approved edits require an exact,
unique old-text match, compile the full tree with Tectonic, and only then commit
a new immutable version. Tool failures are structured `{ ok: false, error, hint
}` results so the model can recover without killing the turn.

## ACP contract

ACP is bidirectional JSON-RPC over `/acp`, not one-way streaming. The browser
calls `initialize`, `session/new`, `session/prompt`, and optionally
`session/cancel`. The API notifies `session/update` for streamed agent events
and can make blocking `session/request_permission` and `session/elicit` calls
back to the browser. All protocol payloads are Zod schemas in `@sailor/acp`;
that package must remain domain-neutral.

`session/new` contains `resumeId`, serialized model reference, and
`jobTargetId`. Passing the real job id here is what makes a created job target
available to the prompt for the entire conversation.
