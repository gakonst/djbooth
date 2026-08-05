# djbooth.ai plugin

Claude Code and Codex packaging for the typed djbooth.ai MCP server.

## Prerequisite

Install `@gakonst/djbooth` and ensure `djbooth --version` succeeds. The plugin starts
`djbooth --mcp`; it does not install executables or duplicate CLI workflow instructions.

## Install

```sh
codex plugin marketplace add gakonst/djbooth
codex plugin add djbooth@djbooth-ai

claude plugin marketplace add gakonst/djbooth
claude plugin install djbooth@djbooth-ai
```

## Workstation

```sh
djbooth serve --open --no-assistant
```

## Development

```sh
pnpm plugin:build
pnpm plugin:check
```
