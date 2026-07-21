# File generation & Files storage

Hosted Cascade runs can now **produce files** for you — documents, code, data —
that you can **download for free** (your browser makes the file) or **save to
Cascade** on our storage, metered by plan. Plus data management: **import chats
& memories**, and **delete chats**.

> Design + security only. No secrets or attacker-useful values here.

## The bug this also fixes (Track A)

A hosted run has no shell/file tools by design, but the cloud config left
runtime **tool creation** on — so the worker would synthesize a phantom
`write_file`/`dynamic_write_file`, call it, produce nothing, and the run failed
("execution failed to produce any output"). Fix:

- The cloud config sets `enableToolCreation: false` + `persistDynamicTools:
  false` — the worker can no longer invent disk tools.
- It's given a real way to deliver a file instead (below), so it stops trying.

## How a run delivers a file (browser-as-host)

There is **no server-side file writing during a run**. The model returns the
file's content in its reply, wrapped in a fenced block tagged with a filename:

    ```file:report.md
    # Quarterly report
    …content…
    ```

The web parses these into **file cards**. A plain code block still gets a
download button as a fallback (filename inferred). From a card you can:

- **Download** — a client-side `Blob` download. Always free; nothing is stored
  on our server.
- **Save to Cascade files** — uploads the content to per-user storage on the
  Railway volume, metered by plan (below).

The worker is steered (a hosted system instruction) to use the `file:` fence
whenever the user asks for a document/file, so files show up as cards, not just
prose.

## Files storage (metered)

| Plan | Storage | At the cap |
| --- | --- | --- |
| Free | 10 MB | Delete files, or upgrade to Pro |
| Pro | 1 GB (a generous metered cap, not "unlimited" — protects the bill) | Delete files |

- Files live under the per-user tenant dir on the persistent volume, tracked by
  a `files` row (`id, user_id, conversation_id?, name, mime, size, created_at`).
- A save that would exceed the cap is rejected (HTTP 413) with a clear
  "delete or upgrade" message; the client surfaces it, never crashes.
- Storage used is the sum of the user's file sizes; shown as a usage bar.

### Endpoints

| Method · Path | Purpose |
| --- | --- |
| `GET /api/files` | List your saved files + storage used / limit |
| `POST /api/files` | Save content as a file (quota-checked; 413 at cap) |
| `GET /api/files/:id` | Download a saved file (owner-scoped) |
| `DELETE /api/files/:id` | Delete a saved file (frees quota) |

## Files panel (right side)

A right-hand **Files** panel lists your saved files with a storage usage bar,
download and delete per file, and an upgrade prompt when the free cap is hit.
Newly generated (unsaved) artifacts from the current chat appear at the top with
Download / Save actions.

## Data management

- **Delete a chat** — `DELETE /api/conversations/:id` (owner-scoped; removes its
  messages + attachments); a delete control in the sidebar.
- **Import chats** — `POST /api/conversations/import` accepts a
  `cascade-export@1` bundle (the same shape the desktop uses) and creates
  conversations you can continue.
- **Import memories** — `POST /api/memories/import` bulk-adds facts from a
  bundle, de-duplicated against existing memories.

## Security

- Files are **owner-scoped** on every read/write/delete; paths are derived from
  a server-generated id, never client input (no path traversal).
- Saved content is size-checked against the plan cap **before** it's written;
  the write is atomic and the `files` row is the source of truth for usage.
- No new code execution: "generation" is the model's text reply; the browser or
  an explicit save is what makes a file. The hosted run still has no shell/file
  tools.

## References

- Plan limits live in `entitlements.ts` (`PlanLimits.storageBytes`); plan comes
  from `billing.ts` (`planForStatus`).
- Uploads/attachments (`POST /api/uploads`) established the per-tenant file
  storage pattern this builds on.
