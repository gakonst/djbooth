# Workspace conventions

- Use pnpm from the repository root; keep one root lockfile.
- Packages live under `packages/`; preserve their public package names and CLI binaries.
- Use `workspace:*` for dependencies between packages in this repository.
- Run a filtered package check while iterating and `pnpm validate` before merging.
- Follow package-local `AGENTS.md` files when present.
- Use conventional commits.

