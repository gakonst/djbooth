# Project conventions

- Keep `PORTING.md` current after each meaningful implementation checkpoint.
- Use conventional commits and keep them focused by format or subsystem.
- Include `.js` extensions in ESM imports.
- Add JSDoc to public exports and prefer `type` over `interface`.
- Preserve unknown XML attributes/elements and binary bytes during round trips.
- Never test database mutations against a user's live Rekordbox library; copy fixtures first.
- Keep CLI outputs structured and bounded so incur can render JSON, TOON, YAML, Markdown, or JSONL.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm build` before checkpoint commits.
