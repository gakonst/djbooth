import { conversationAccess, FAST_AGENT_CONVERSATION_ID } from "../src/agent-permissions";
import { Client, Dialog, Transport } from "nanocodex/connect";
import { expect, test, vi } from "vitest";
import { phoneTools, phoneToolDigest } from "../src/phone-tools";

test.each(
  [undefined, FAST_AGENT_CONVERSATION_ID].flatMap((conversationId) =>
    [[], ["spotify"], ["soundcloud"], ["spotify", "soundcloud"]].map((connectors) => ({
      conversationId,
      connectors,
    })),
  ),
)(
  "the SDK signs thread $conversationId and music connections $connectors without ChatGPT",
  async ({ conversationId, connectors }) => {
    const wallet = vi.fn(async () => ({
      accounts: [
        { address: `0x${"1".repeat(40)}`, capabilities: { auth: { approval_id: "approved" } } },
      ],
    }));
    const request = vi.fn(async () => ({
      grant_token: "a".repeat(43),
      account_id: "account-a",
      account_address: `0x${"1".repeat(40)}`,
      agent_id: "agent-a",
      authorization_mode: "hosted",
      grant: {
        id: `0x${"2".repeat(64)}`,
        permission: "agent.run",
        status: "active",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        capabilities: [
          "nanocodex.agent",
          "agent.output.final",
          "agent.history.read",
          "agent.output.actions",
          ...connectors,
        ],
        mcp_connections: [],
        app_tool_catalog_digest: await phoneToolDigest(),
        ...(conversationId ? { conversation_id: conversationId } : {}),
      },
    }));
    const client = Client.create({
      appId: "djbooth",
      appOrigin: "https://library.example",
      session: false,
      auth: { resources: ["urn:nanocodex:agent:run"] },
      dialog: Dialog.memory(),
      provider: { request: wallet },
      transport: Transport.from({
        key: "test",
        name: "test",
        type: "test",
        setup: () => ({ baseUrl: "https://issuer.example", request }),
      }),
    });
    const connection = await client.connection.connect({
      conversationId,
      authorization: "hosted",
      permission: "agent.run",
      tools: phoneTools,
      capabilities: {
        agent: conversationAccess,
        cloudAccounts: {
          ...(connectors.includes("spotify") ? { spotify: true } : {}),
          ...(connectors.includes("soundcloud") ? { soundcloud: true } : {}),
        },
      },
    });
    const call = wallet.mock.calls[0] as unknown as [
      {
        params: { capabilities: { auth: { resources: string[] }; authorizeAccessKey?: unknown } }[];
      },
    ];
    const resources = call[0].params[0].capabilities.auth.resources;
    expect(
      resources.filter((resource) => resource.startsWith("urn:nanocodex:connectors:")),
    ).toEqual(connectors.length ? [`urn:nanocodex:connectors:${connectors.join(",")}`] : []);
    expect(resources.some((resource) => resource.includes("chatgpt"))).toBe(false);
    expect(resources).toContain("urn:nanocodex:agent:visibility:reply,actions,history");
    expect(resources.filter((resource) => resource.startsWith("urn:nanocodex:agent:"))).toEqual([
      "urn:nanocodex:agent:run",
      "urn:nanocodex:agent:visibility:reply,actions,history",
      ...(conversationId ? [`urn:nanocodex:agent:conversation:${conversationId}`] : []),
    ]);
    expect(resources).not.toContain("urn:nanocodex:history:read");
    expect(resources).not.toContain("urn:nanocodex:agent:trace:read");
    expect(call[0].params[0].capabilities.authorizeAccessKey).toBeUndefined();
    expect(connection.grant.connectors).toEqual(connectors);
    expect(connection.grant.appToolCatalogDigest).toBe(await phoneToolDigest());
    expect(connection.grant.conversationId).toBe(conversationId);
    expect(call[0].params[0].capabilities.auth.resources).toContain(
      `urn:nanocodex:app-tool-catalog:sha256:${(await phoneToolDigest()).slice(2)}`,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          ...(connectors.length ? { requested_connectors: connectors } : {}),
          requested_app_tool_catalog_digest: await phoneToolDigest(),
        }),
      }),
    );
    if (!connectors.length) {
      const call = request.mock.calls[0] as unknown as [{ body: Record<string, unknown> }];
      expect(call[0].body.requested_connectors).toBeUndefined();
    }
  },
);
