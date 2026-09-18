# Agentic document navigation

Design analysis. No implementation. The recommendation is at the end of each
section; the reasoning is the point of the document.

Status: proposal. The three open questions in §8 are decided; Phase 0 (§6) is
in progress. Nothing else here is built.

---

## 0. The premise that is wrong, before anything else

The request that produced this document was "give the model more context
without overloading it." That framing assumes Cascade lacks a mechanism for
large documents. It does not. It has three, and they are good:

- **Adaptive CAG/RAG.** `resolveDocuments` (`cloud/server/src/runs.ts:976`)
  computes the run's real context window from the user's *actually pinned*
  models (`runContextWindowTokens`, `runs.ts:945`), derives a character budget
  from it, injects small corpora whole, and chunk-embed-retrieves large ones.
  Its own comment says "no fixed byte cliff."
- **Compaction and map-reduce.** `applyExtendedContext` (`src/core/cascade.ts`)
  folds over-budget history into a rolling summary and chunk-summarises
  oversized single inputs, behind a confirm gate.
- **A full retrieval stack in the SDK.** `src/retrieval/` — chunker, embedder,
  `SqliteVectorStore`, `Retriever` with hybrid fusion, `LLMReranker`,
  `WorkspaceIndex`, `GraphRetriever`.

**The reason a user sees truncation is not a missing mechanism.** It is
`normalizeText` (`cloud/server/src/documents.ts:52`) hard-cutting extracted text
at `MAX_EXTRACTED_CHARS = 200_000` (`documents.ts:12`) *at upload time*, before
storage. Only the truncated text is persisted as `extractedText`
(`cloud/server/src/app.ts:1011`). Everything downstream inherits a decision made
by the layer least qualified to make it.

The original bytes are still on disk (`app.ts:1008`). The data is not lost. It
is simply never shown to the machinery built to handle it.

**Recommendation.** Treat the truncation as a prerequisite bug, not part of this
feature. You cannot navigate a document whose second half was deleted on the way
in. Section 6 phases it accordingly.

---

## 1. What is actually missing

Compare the two surfaces honestly.

**CLI and desktop already navigate agentically.** The model has `file_read`,
`file_list`, `glob`, `grep`, and `code_search` over an indexed `WorkspaceIndex`.
Asked about a repository it does what a person does: list, search, open the
relevant file. Nobody flattens the repo into the prompt.

**The hosted web app cannot navigate at all.** Documents are resolved once and
flattened into the prompt string by `buildRunPrompt` (`runs.ts:854`). The model
receives whatever CAG injected or whatever RAG's `RAG_TOP_K = 8`
(`runs.ts:935`) guessed from the *opening* prompt, and has no way to ask for
more. One shot, no recourse.

So the gap is not "more context." It is that **one endpoint can explore and the
others cannot**, and the exploring one cannot explore *documents* — only files
and code.

This also explains why retrieval underperforms on the questions users care
about. Top-K similarity answers "which passages resemble the question." It does
not answer "what does clause 7.3 say," "does page 40 contradict page 12," or
"summarise chapter 4" — those need *navigation*, not *similarity*. No amount of
tuning K fixes a category error.

**Recommendation.** Frame the feature as closing an endpoint asymmetry, not as
extending context. It keeps the scope honest and it tells you where the code
belongs.

---

## 2. Where the code lives

`CodeSearchTool` (`src/tools/code-search.ts:30`) takes a `WorkspaceIndex` in its
constructor. `BrowserControlTool` takes a controller and a per-run
`BrowserActionContext` (`src/tools/browser-control.ts:65`). Both are SDK tools
whose *corpus* or *host capability* is injected by whoever is embedding them.

That is the pattern, it already works twice, and the one time this codebase
diverged — the browser live-view listener registered under a key nothing
listened on — it produced a bug that took a field report and several review
rounds to find.

**Recommendation.** The tools live in `src/tools/`, backed by `src/retrieval/`.
The cloud server, the CLI and the desktop app each supply a corpus. No
cloud-only implementation, no duplicated chunking. One code path, three hosts.

---

## 3. The port: `DocumentCorpus`

The single abstraction the hosts implement.

```ts
export interface DocumentRef {
  docId: string;           // stable within the run
  filename: string;
  mime: string;
  sections: SectionRef[];  // the map — see §4
  charCount: number;
}

export interface SectionRef {
  id: string;              // stable locator, e.g. "p12" or "s3.2"
  title: string;           // heading, or a generated one-line gist
  from: number; to: number; // char offsets within the document
}

export interface DocumentCorpus {
  list(): Promise<DocumentRef[]>;
  /** Exact span by locator. No embeddings involved. */
  read(docId: string, sectionId: string): Promise<string>;
  /** Ranked passages. Falls back to lexical when no embedder exists. */
  search(query: string, opts: { docId?: string; k: number }): Promise<Passage[]>;
}
```

Implementations:

| Host | Corpus source | Vector store |
|---|---|---|
| CLI | Files named on the command line, lazily extracted | existing `.cascade` SQLite |
| Desktop | Same as CLI, plus the app's attachment store | app SQLite |
| Web (self-hosted) | `attachments` table | `store.getVectorStore()` (`db.ts:279`) |
| Web (hosted) | identical to self-hosted | identical |

Self-hosted and hosted are **the same code path**. They differ only in quota and
billing policy, which is where they already differ. Any design that forks them
is wrong.

**Recommendation.** Ship `DocumentCorpus` as the only seam. Resist a second one.

---

## 4. The tool surface: three verbs

Map, find, fetch. This is what a person does with an unfamiliar document, and
what the CLI model already does with an unfamiliar repository.

### `document_outline(docId?)` — the map

Returns the section tree: headings, page ranges, char counts, and a one-line
gist per section. For a 300-page PDF this is perhaps 1–2k tokens.

**This is the load-bearing verb**, and it is the one a naive design omits.
Without a map the model does not know the document *has* a chapter 7, so it
never asks for it, and you have built a tool nobody calls. The outline is what
converts a passive attachment into something with visible structure.

### `document_search(query, docId?, k?)` — find

Hybrid semantic + lexical over the chunk index, via the existing `Retriever`
(`src/retrieval/retriever.ts:46`). Returns passages **with their locators**, not
bare text — every result must be an address the model can then read around.

### `document_read(docId, sectionId, span?)` — fetch

Exact text at an exact locator. Deterministic, no ranking, no embeddings.

**Recommendation.** Three verbs, not one. A single `search` tool is the
half-baked version — it is RAG with extra steps and it inherits RAG's category
error from §1.

---

## 5. Two properties that make this better than RAG

### 5.1 It degrades correctly without an embeddings key

Today, a user with no embeddings-capable key and a large corpus gets the whole
document injected (`runs.ts:996`) — which is exactly the overload we are trying
to avoid, and is currently prevented only *by accident*, by the 200k truncation
this design removes.

Of the three verbs, **two need no embeddings at all**. `document_outline` is
structural parsing. `document_read` is a substring. Only `document_search`'s
semantic ranking needs vectors, and it degrades to lexical/BM25 rather than
vanishing.

So a no-key user goes from "the whole document, or the first 200k characters of
it" to "a map and the ability to read any part of it." That is a strict
improvement, and it closes the open no-key hole rather than widening it.

### 5.2 The cost is bounded by what the model actually reads

CAG pays for the whole document every turn. Navigation pays for the outline plus
the spans requested. For a question about one clause in a long contract that is
a large constant-factor saving, and it compounds across a conversation.

**Recommendation.** Lead the phasing with the embedding-free verbs (§6). They
deliver working navigation at zero embedding cost and zero new spend.

---

## 6. Phasing

Each phase is shippable and independently useful. No phase leaves a half-built
surface behind.

**Phase 0 — stop destroying the data.** Remove the truncation from
`normalizeText`; store full extracted text. Raise the ingestion limit to a
resource-safety bound (memory and per-plan storage quota), not a context bound.
Fix the no-key path in `resolveDocuments` so an uncapped corpus cannot be
injected whole. *Prerequisite: nothing below works on a truncated document.*

**Phase 1 — outline and read, no embeddings.** `DocumentCorpus`, the section
parser, `document_outline`, `document_read`, wired on all four hosts. Inject the
outline instead of the document text. Fully functional navigation, no new spend.

**Phase 2 — search.** `document_search` over the existing `Retriever`, with
lexical fallback. Indexing consent through the existing
`context:approval-required` gate; index cached per attachment + embed model, as
`Retriever.isIndexed` already does.

**Phase 3 — surface polish.** Socket events so the web UI can show what was
read (the `knowledge:retrieved` pattern), and a CLI/desktop equivalent.

**Recommendation.** Do not start at Phase 2 because it is the interesting one.
Phase 1 is what makes Phase 2 get called.

---

## 7. Security and safety

- **`document_read` is corpus-scoped, never a filesystem reader.** On CLI and
  desktop the temptation is to implement it as `fs.readFile`. That converts a
  document tool into an unsandboxed file-read primitive reachable by prompt
  injection from inside an untrusted PDF. It resolves `docId` against the
  corpus, and a `docId` not in `list()` is an error, not a path.
- **Uploaded documents are untrusted input.** Text extracted from a user's PDF
  can contain instructions. It is data, and the prompt that carries it should
  say so. This risk exists today; navigation does not create it, but it does
  increase the surface, because the model now fetches more of the document.
- **The outline is generated, not trusted.** Section titles come from the
  document. They are displayed to the model as labels, never executed as
  routing instructions.

---

## 8. Decisions

The three questions this document was written to raise have been answered.

### 8.1 CLI corpus scope — **unify**

The CLI's corpus is not a second, parallel thing beside `WorkspaceIndex`.
`document_*` and `code_search` become one navigation surface: files in the
workspace and documents the user attached are both addressable, with the same
three verbs.

This is the more coherent answer and the more work, and it is worth it for a
reason this codebase has already paid for twice: two indexes over the same
corpus drift. `code_search` and a separate `document_search` would answer the
same question differently depending on whether a file happened to arrive as a
workspace file or as an attachment, which is exactly the class of surprise the
run-identity work spent several rounds removing.

Consequence for §3: the CLI and desktop `DocumentCorpus` implementations are
adapters over `WorkspaceIndex` rather than a separate store, and `document_read`
resolves locators through it. `code_search` stays as a name — it is the
narrower, code-shaped entry point people already use — but both sit on one index.

### 8.2 Hosted spend — **a per-plan size ceiling, not a per-run gate**

Free accounts may upload documents up to **5 MB**; larger files require a paid
plan. The ceiling lives in `PlanLimits` beside the quotas that already exist
(`cloud/server/src/entitlements.ts`), not as a constant in the upload handler.

This answers the spend question by bounding the input rather than interrupting
the user: indexing cost is a function of document size, so capping size per plan
caps the cost per plan. It is also the honest place for the limit — the previous
200k-character cut was a *context* decision wearing a resource limit's clothes,
and this is the resource limit it was pretending to be.

Residual, deliberately not solved here: a paid user attaching several 10 MB
documents in one run can still run up a real embedding bill on first index.
Phase 2 can put that behind the existing `context:approval-required` gate if it
proves to matter; it is not worth a consent prompt before then.

### 8.3 Structureless documents — **user-selectable, page-wise by default**

The outline strategy is a user setting, defaulting to **page-wise**.

Page-wise is the right default because it is the only strategy that is always
available and never lies: every document has positions, not every document has
headings. Heading-derived sections are better when headings exist; LLM-generated
gists are better still and cost a pass over the document at ingestion. The user
picks; the default never fails.

One wrinkle to handle rather than paper over: "page" is a PDF concept. For
DOCX, Markdown and plain text there are no pages, so the page-wise strategy
degrades to fixed-size positional windows labelled by their char range. The
setting is therefore named for the *idea* — positional rather than semantic —
not for the PDF-specific word.
