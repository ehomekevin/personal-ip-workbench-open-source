# Article layout model/storage leaf verification

Run from the project work directory:

```sh
node --test --test-concurrency=1 tests/article-layout/model/*.test.ts
```

Verified 41 cases: 18 model, 11 existing `Documents` and real SQLite/revision file saves, 12 durable journal/budget and process/Wiki file cases. Test workspaces stay under this directory and are removed after each case. Native AI, image generation, external fees, production services and production records are not used.

`ArticleLayoutService.save` is the editor port. It rejects injected checks, render provenance, confirmations, image source/adoption facts and new standard sources. Server consumers use `adoptImages` with a trusted image producer, `syncCheck` with the original journal/proof, and `confirm` with the request actor plus actual human decision reference. `initialize` is a trusted-server operation; its upstream review must come from the producer and never from untrusted request JSON.

The aggregate `snapshot.text_hash` hashes canonical exact source bytes plus stable-ID captions. It differs from the Document file hash and the opaque upstream review hash. Caption edits create an official Document revision without inserting/deleting source paragraphs. Style-only saves do not add a Document text revision. Intermediate input versions stay in content history; the committed head binds to the official Document revision.

The durable metadata journal validates loaded execution records, freezes job/attempt/native/input identities and forbids repeat submission, identity swaps and terminal mutation. A completed result requires verified original input, known native IDs and an output hash equal to the canonical result digest. The service independently repeats this output-hash check before consuming a result. The budget fixes one candidate and at most two explicit jobs in the workspace's `WECHAT-LAYOUT-STUDIO-01/r1` ledger. Reopening or changing the permit ID cannot create another budget.

Record writers require exact new `process/article-layout` and `wiki/article-layout` roots, the owner registration reference and explicit fixture/production scope. Process records retain the JSONL machine journal and write one immutable Obsidian-readable Markdown note per event under the same process root. Notes show original/manual before-and-after text, layout adjustments, AI issues and human decisions. Receipts provide both JSONL and Markdown paths/hashes. Repeated events deduplicate, modified Markdown is refused, and a missing Markdown note can be recovered from an existing matching machine event without changing that journal. Wiki writes require a saved current human-confirmed combination, use its combination hash, refuse overwrite and return actual file hashes. Fixture file writes do not prove production Obsidian/Wiki integration.

New core leaves were strictly typechecked in a temporary stage before promotion. The parent owns final composed typechecking. Browser interaction, OS IME, real visual understanding, image producer r2 and production record roots are outside these tests.
