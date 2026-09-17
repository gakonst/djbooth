import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createTools } from "nanocodex/tools";
import { hostedAppToolCatalog, hostedToolCatalogDigest } from "nanocodex/tools/hosted-catalog";
import { appMcpTools, phoneToolCatalog, phoneToolDigest, phoneTools } from "../src/phone-tools";

test("Swift's bundled catalog hash matches the normalized Nanocodex approval hash", async () => {
  const canonical = (value: any): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(",")}}`
        : JSON.stringify(value);
  expect(
    "0x" +
      createHash("sha256")
        .update("nanocodex-app-tool-catalog-v1\0" + canonical(phoneToolCatalog))
        .digest("hex"),
  ).toBe(await phoneToolDigest());
});

test("approval matches Nanocodex's real MCP reverse attachment, including provider and remote name", async () => {
  let catalog: unknown;
  const listeners = new Map<string, (event: any) => void>();
  const socket = {
    readyState: 1,
    send(text: string) {
      const frame = JSON.parse(text);
      if (frame.type === "drain")
        queueMicrotask(() =>
          listeners.get("message")?.({ data: JSON.stringify({ type: "draining" }) }),
        );
      if (frame.type === "catalog") {
        catalog = frame.tools;
        queueMicrotask(() =>
          listeners.get("message")?.({ data: JSON.stringify({ type: "ready" }) }),
        );
      }
    },
    close() {
      listeners.get("close")?.({});
    },
    addEventListener(type: string, listener: (event: any) => void) {
      listeners.set(type, listener);
    },
  };
  const runtime = await createTools({
    tools: phoneTools.filter((tool) => tool.name === "djbooth_exec"),
    mcp: {
      djbooth: {
        client: {
          listTools: async () => ({ tools: appMcpTools }),
          callTool: async () => ({ content: [] }),
        },
      },
    },
    mcpOptions: { catalogProvider: () => "javascript" },
  });
  try {
    await runtime
      .attach({ endpoint: "wss://example.test/tools", transport: { connect: () => socket } })
      .connect();
    expect(await hostedToolCatalogDigest(catalog as any)).toBe(await phoneToolDigest());
    expect(await hostedToolCatalogDigest(hostedAppToolCatalog(phoneTools))).toBe(
      await phoneToolDigest(),
    );
    expect(phoneToolCatalog.length).toBe(appMcpTools.length + 1);
  } finally {
    await runtime.close();
  }
});
