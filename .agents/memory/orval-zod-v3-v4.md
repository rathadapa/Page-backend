---
name: Orval zod-version auto-detection defaults to v4
description: Why orval-generated zod schemas can use v4-only syntax (e.g. zod.uuid()) even when the workspace pins zod v3, and how to fix it.
---

Orval's zod client plugin decides whether to emit zod-v4-style calls (e.g.
top-level `zod.uuid()`, `zod.iso.datetime()`) or zod-v3-style calls (e.g.
`zod.string().uuid()`) based on `override.zod.version` in `orval.config.ts`.
When left at the default `'auto'`, it tries to read the installed zod version
from the *output workspace's* `package.json` — but if it can't resolve that
metadata, it now **defaults to v4 syntax**, even if zod v3 is what's actually
installed. This produces generated code that fails typecheck with errors like
`Property 'uuid' does not exist on type 'typeof zod'`.

**Why:** hit this while adding new OpenAPI operations with `format: uuid`
response fields in a workspace pinned to zod `^3.25.76` — codegen ran clean
but `tsc --build` failed only in the freshly generated file.

**How to apply:** if the workspace uses zod v3, explicitly set
`override.zod.version: 3` under the `zod` output config in
`orval.config.ts`. Don't rely on `'auto'` detection. Re-run codegen after
changing this — it regenerates all affected files.
