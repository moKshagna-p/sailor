# Architecture

Sailor is a resume editor where an agent tailors a user's LaTeX resume to a
specific, real job description. The design optimizes three properties: claims
must be grounded in the user's resume, every edit must be reversible, and every
stored document must compile.

## Package boundaries

```text
@sailor/core  ←  @sailor/db       ←  @sailor/agent  →  @sailor/providers
@sailor/core  ←  @sailor/latex    ←  @sailor/agent
@sailor/core  ←  @sailor/acp

@sailor/agent + @sailor/acp + @sailor/db + @sailor/latex  →  apps/api
                                                                  ↑ HTTP / WebSocket
                                                               apps/web
```

- `packages/core` owns Zod schemas and dependency-free shared types.
- `packages/db` owns Drizzle, SQL, encryption, and all persistence helpers.
- `packages/latex` only compiles LaTeX; it does not decide what to write.
- `packages/providers` is the provider-neutral model gateway. Provider SDK
  imports are confined to `src/drivers/`.
- `packages/agent` owns the prompt, loop, and tools. Its tools are defined once
  and exposed both in-process and through MCP.
- `packages/acp` owns the JSON-RPC protocol only; it deliberately knows nothing
  about resumes.
- `apps/api` is a thin Elysia boundary: HTTP routes, OAuth callbacks, and the
  ACP bridge.
- `apps/web` is a Next.js UI. It talks to the API over HTTP and one ACP WebSocket;
  it must never import the database, agent, or a provider SDK.

## Data model and reversibility

`resumes.currentVersionId` points at an immutable `resume_versions` row. A row
stores a complete `ResumeTree`, a content hash, a summary, a creator, and a
`parentId`. `commitVersion()` inserts a new row; it does not mutate prior
content. A rollback is another commit whose content is copied from the selected
version, so rollback is itself reversible.

Provider credentials are encrypted in `provider_credentials`. Public API
queries expose only provider, kind, label, and expiry. The only plaintext-secret
reader is `getDecryptedCredential()` in `@sailor/db`.

Job targets are separate records. An ACP session holds the selected
`jobTargetId`, making the job description explicit in the agent context instead
of relying on a chat message to survive a refresh.

## Request flow

1. The browser creates or loads a resume through the API.
2. The editor previews source through a worker and the authoritative compile
   endpoint. Saved versions are compiled server-side before persistence.
3. The browser creates a job target with `POST /api/jobs`, then opens an ACP
   session carrying the resume id, model ref, and job target id.
4. The API resolves the user's credential through `@sailor/providers`, including
   an OAuth refresh when necessary, and runs one agent turn.
5. Agent events stream to the browser as ACP notifications. A resume mutation is
   an ACP request that blocks for a human allow/deny response.
6. An approved edit is compiled with Tectonic. Only a successful build creates a
   new immutable version and a `version_committed` event.

## Boundaries worth preserving

Every HTTP body, WebSocket frame, tool input, and provider response is parsed at
its boundary. SQL belongs in `@sailor/db`; provider-specific OAuth and SDK calls
belong in provider drivers. Keep those seams intact when adding features: moving
logic outward tends to leak credentials into the client or duplicate behavior
between ACP and MCP.
