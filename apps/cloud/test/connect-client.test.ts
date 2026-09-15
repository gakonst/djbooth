import { Client, Dialog, Transport } from "nanocodex/connect";
import { expect, test, vi } from "vitest";
import { phoneTools, phoneToolDigest } from "../src/phone-tools";

test("the installed SDK signs and retains Spotify and SoundCloud in the hosted grant", async () => {
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
        "agent.output.actions",
        "spotify",
        "soundcloud",
        "chatgpt",
      ],
      mcp_connections: [],
      app_tool_catalog_digest: await phoneToolDigest(),
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
    authorization: "hosted",
    permission: "agent.run",
    tools: phoneTools,
    capabilities: { cloudAccounts: { chatgpt: true, spotify: true, soundcloud: true } },
  });
  const call = wallet.mock.calls[0] as unknown as [
    { params: { capabilities: { auth: { resources: string[] }; authorizeAccessKey?: unknown } }[] },
  ];
  expect(call[0].params[0].capabilities.auth.resources).toContain(
    "urn:nanocodex:connectors:spotify,soundcloud,chatgpt",
  );
  expect(call[0].params[0].capabilities.authorizeAccessKey).toBeUndefined();
  expect(connection.grant.connectors).toEqual(["spotify", "soundcloud", "chatgpt"]);
  expect(connection.grant.appToolCatalogDigest).toBe(await phoneToolDigest());
  expect(call[0].params[0].capabilities.auth.resources).toContain(
    `urn:nanocodex:app-tool-catalog:sha256:${(await phoneToolDigest()).slice(2)}`,
  );
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.objectContaining({
        requested_connectors: ["spotify", "soundcloud", "chatgpt"],
        requested_app_tool_catalog_digest: await phoneToolDigest(),
      }),
    }),
  );
});
