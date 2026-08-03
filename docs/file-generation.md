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

## Office / PDF exports (browser renders the binary)

A run streams text, so it can never emit a binary directly. For **PDF**,
**Excel**, **Word** and **PowerPoint** the model instead writes the *source* and
names the block with the target extension; the browser turns it into the real
binary. The parsing and the Office renderers live in **`src/core/documents/`**
(the SDK) and are imported by `cloud/web/src/lib/exporters.ts` through the
`@cascade/documents` alias — see "One renderer, two hosts" below. The exporter
file itself keeps only the browser-specific parts: the `/api/files/:id` fetch,
the Blob wrappers and the jsPDF layout. A small Markdown subset is parsed once
into a shared block model:

- `file:report.pdf` whose body is **Markdown** → a genuine `.pdf` via `jsPDF`
  (headings, paragraphs, bullet/number lists, code fences, blockquotes, tables
  and rules with word-wrap and page breaks), producing **selectable text** (not
  a rasterised image).
- `file:data.xlsx` whose body is **CSV** → a proper `.xlsx` workbook (SheetJS
  `aoa_to_sheet`, reusing the same `parseDelimited` CSV parser as the viewer).
- `file:report.docx` whose body is **Markdown** → a Word document (`docx`
  library) with styled inline runs, bullet/numbered lists, code, quotes, tables.
- `file:deck.pptx` whose body is **Markdown** → a PowerPoint deck (`pptxgenjs`):
  slides split on `---` rules (or top-level headings), each slide's heading is
  the title and its bullets/lines become the body.

The heavy libraries are loaded with dynamic `import()`, so they ship as separate
chunks that download only the first time a user exports one of these formats and
never enter the base bundle; rendering happens entirely client-side, so the
content never leaves the browser. Office/PDF cards offer **View + Download +
Save** like text files: **View** previews a real PDF inline (an object-URL
iframe) and previews Excel/Word/PowerPoint as their Markdown/CSV source (there is
no in-browser Office renderer); **Save** stores the actual rendered binary — the
metered `/api/files` store accepts a base64 body (`encoding: 'base64'`), and the
Files panel previews a saved PDF inline and offers "download to open" for Office
binaries. The hosted guidance (`FILE_DELIVERY_GUIDANCE`) tells the model how to
target these formats, still only when the user explicitly asks for a file.

## One renderer, two hosts (desktop/CLI got nothing until v0.67.0)

Everything above described the *hosted* path only. On desktop and the CLI the
only file-writing tool was `file_write`, whose `execute()` is a plain
`fs.writeFile(path, content, 'utf-8')` with no awareness of the extension — so
asking for `report.docx` wrote literal Markdown into a file named `.docx`, and
Word/Excel/PowerPoint correctly reported it as **corrupted**. There was no
conversion step anywhere outside the browser.

The fix is a dedicated tool, **`generate_document`** (`src/tools/generate-document.ts`):
the model passes a target path plus the same source conventions as above
(Markdown → `.docx`, Markdown slides → `.pptx`, CSV → `.xlsx`) and the tool
renders the real OOXML archive in Node and `fs.writeFile`s the bytes. It is
registered wherever there is a real workspace (desktop, CLI, SDK — via
`Cascade`'s constructor), and absent on a host with no filesystem, mirroring how
`transcribe_audio` is gated on a file reader. `pdf_create` still owns PDFs.

`file_write` was deliberately **not** taught to reinterpret those extensions: a
tool the model understands as "write these exact bytes" has to keep meaning
that, or writing already-valid `.docx` bytes through it would silently corrupt
them.

The parser and renderers are shared, not copied — `src/core/documents/`:

| Piece | Why it's portable |
| --- | --- |
| `blocks.ts` | `parseBlocks`, `stripInline`, `inlineRuns`, `sniffImage`, `splitSlides`/`parseSlide`, the chart parser, `parseDelimited`. No DOM, no `fs`, no `Buffer` reference (base64 feature-detects off `globalThis`). |
| `render.ts` | `renderDocx`/`renderPptx`/`renderXlsx`, all returning `Uint8Array`. The two non-portable bits are injected: images arrive through a `loadImageBytes(url)` callback (browser `fetch` with the session cookie; `fs.readFile` on desktop), and docx is packed with `Packer.toArrayBuffer`, the one packer that needs neither a Node `Buffer` nor a DOM `Blob`. |

`cloud/web` reaches it through a `@cascade/documents` alias declared in
`vite.config.ts`, `vitest.config.ts` and `tsconfig.json`; the SDK re-exports the
same surface from `src/index.ts`. One implementation, two importers — the
alternative had already cost the codebase a docx image page-height fix that
landed in only one copy.

## Charts: `chart:` blocks become real chart objects

A model asked to visualize data used to have two options, both bad: draw it with
an image model (which cannot be trusted to get numbers, axes or labels right) or
emit a flat Markdown table (which is not a chart) — and in practice it sometimes
did neither, just describing the chart in prose. There is now a third:

    ```chart:bar
    title: Quarterly revenue
    Quarter,Revenue,Costs
    Q1,120,80
    Q2,150,95
    ```

`chart:bar`, `chart:line`, `chart:pie`, `chart:doughnut`, `chart:area`,
`chart:scatter` (plus aliases: `column`→bar, `donut`→doughnut). The body is CSV —
the same format the `.xlsx` convention already uses, chosen over JSON because
models emit it far more reliably and a malformed row degrades to one bad row
rather than a failed parse. An optional leading `title:` line names the chart.
The header row is `<category label>,<series>,<series>…`; each later row is a
category plus its numbers. Decorated values (`$1,200`, `42%`, `(50)`) are
coerced; anything unparseable becomes `0` rather than poisoning the series. A
block that cannot be parsed at all stays a visible code block — never a silent
drop.

What each format does with it:

| Format | Result |
| --- | --- |
| `.pptx` | A **real, editable PowerPoint chart** via `pptxgenjs` `addChart` — the numbers live in the chart part's embedded workbook (`ppt/charts/chart1.xml`), so "Edit Data" shows exactly what the model wrote. |
| `.docx` | A titled Word **table** of the same numbers. The `docx` library exposes no chart API at all (a Word chart needs a DrawingML chart part plus an embedded workbook, which it does not model), so this is a documented gap, not an oversight — the data is never dropped. |
| `.xlsx` | Each chart's data goes onto **its own worksheet as real numeric rows** the user can chart in one click. SheetJS's community build writes cells, not chart objects. |
| `.pdf` | Title + table (jsPDF draws no charts). |

Both the hosted guidance (`FILE_DELIVERY_GUIDANCE`) and the desktop/CLI worker
rules (`buildWorkerRules`) now teach this convention explicitly, replacing the
old "fall back to a Markdown table" advice.

## Image reliability

Two separate causes, both addressed:

- **The tool may not exist.** `generate_image` is only registered when an OpenAI
  or Gemini key is configured (`multimodal/registry.ts`'s `CAPABILITIES`). With
  neither, the model was never given a choice — and an uninformed model writes
  `[illustration of a cat]` and moves on. `buildWorkerRules` now emits an
  explicit "no image-generation model is available on this run" rule in that
  case, pointing at `chart:` blocks for anything data-driven.
- **The rule wasn't always followed.** The `generate_image` instruction is
  tightened (call it *before* writing the document, one call per image, the
  reference must stand **alone** on its line or it stays prose) and, more
  importantly, made *checkable*: `missingVisualEvidence()` runs after the agent
  loop and, when the subtask asked for a visual but the output contains no image
  reference, no `chart:` block and no `generate_image`/`generate_document` call,
  triggers one correction round with tools. `verifyArtifacts()` additionally
  asserts that a promised `.docx`/`.pptx`/`.xlsx` really starts with the ZIP
  signature `PK\x03\x04`.

The worker is steered (a hosted system instruction) to use the `file:` fence —
but only on turns whose request actually looks file-shaped (`wantsFileDelivery`:
the user's own text or the active skill mentions a file/document/export, or the
previous assistant turn already delivered a `file:` block). The guidance itself
contains no fenced example and says to emit `file:` blocks ONLY when explicitly
asked; both guards exist because injecting an example fence on every turn made
small models echo a phantom `report.md` in reply to a bare "hi".

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
