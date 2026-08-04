# Workspace conventions

- Use pnpm from the repository root; keep one root lockfile.
- Publishable libraries and CLIs live under `packages/`; application surfaces live under `apps/`.
- Active Rust lives in the `rust/` workspace; standalone Python tools live under `python/`.
- Use `workspace:*` for dependencies between packages in this repository.
- Run a filtered package check while iterating and `pnpm validate` before merging.
- Follow package-local `AGENTS.md` files when present.
- Use conventional commits.
