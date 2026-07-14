# CLAUDE.md

This project keeps **one** set of agent instructions, and it lives in AGENTS.md.
Do not duplicate rules here — a second copy always drifts out of sync with the first.

@AGENTS.md

Additional context, loaded on demand (read these when the task touches them —
do not read them all up front):

- @docs/architecture.md — how the packages fit together, and why
- @docs/providers.md — the model gateway: adding a provider, OAuth vs API key
- @docs/agent.md — the resume agent: tools, permissions, the ACP contract
- @docs/latex.md — the dual compile path (WASM preview + Tectonic authoritative)
