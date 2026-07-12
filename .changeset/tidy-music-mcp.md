---
"@gakonst/music": minor
---

Export normal and CodeMode MCP server factories backed by the unified incur command map. CodeMode
uses an injected sandbox executor and exposes the music tools through one TypeScript `code` tool.
Add `music --codemode-mcp` as a zero-config local server backed by deny-by-default Secure Exec
isolation.
