import { afterEach, expect, test, vi } from "vitest";
import { createMusicAgent, type MusicAgentAPI } from "../client/music-agent.js";

afterEach(() => vi.useRealTimers());
function setup(status = "running") {
  const request = vi.fn(
    async (path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> => {
      signal?.throwIfAborted();
      if (path === "/v1/auth/session") return { account: { grantId: "grant" } };
      if (path === "/v1/agent/turns")
        return { id: (body as { id: string }).id, status, finalMessage: "Done" };
      if (path.endsWith("/cancel")) return { id: "turn", status: "cancelling" };
      return { id: "turn", status: "completed", finalMessage: "Found your music" };
    },
  );
  return { request, agent: createMusicAgent(request as MusicAgentAPI, "grant") };
}

test("the SDK adapter validates the same grant, submits once, and polls the same turn", async () => {
  vi.useFakeTimers();
  const { agent, request } = setup();
  const watcher = agent.events.watch();
  const events = vi.fn();
  watcher.onEvent(events);
  const turn = agent.turn.prompt({ input: "Find a track" });
  const result = turn.result();
  expect(turn.result()).toBe(result);
  await vi.advanceTimersByTimeAsync(1500);
  expect((await result).finalMessage).toBe("Found your music");
  const id = (request.mock.calls[1][1] as { id: string }).id;
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "/v1/auth/session",
    "/v1/agent/turns",
    `/v1/agent/turns/${id}`,
  ]);
  expect(request.mock.calls[1][1]).toEqual({ id, input: "Find a track" });
  expect(events).toHaveBeenCalledWith(
    expect.objectContaining({ request_id: "grant", type: "run.started", payload: { turn_id: id } }),
  );
  turn.dispose();
  watcher.off();
});

test("a changed account cannot submit a turn", async () => {
  const { agent, request } = setup();
  request.mockResolvedValueOnce({ account: { grantId: "other" } });
  await expect(agent.turn.prompt({ input: "Find a track" }).result()).rejects.toThrow(
    "account changed",
  );
  expect(request).toHaveBeenCalledTimes(1);
});

test("ambiguous submission failures are surfaced without resubmission", async () => {
  const { agent, request } = setup();
  request
    .mockResolvedValueOnce({ account: { grantId: "grant" } })
    .mockRejectedValueOnce(new Error("Connection lost"));
  const turn = agent.turn.prompt({ input: "Import my playlist" });
  await expect(turn.result()).rejects.toThrow("Connection lost");
  await expect(turn.result()).rejects.toThrow("Connection lost");
  expect(request).toHaveBeenCalledTimes(2);
});

test("stop targets the accepted turn once and waits for cancellation to finish", async () => {
  vi.useFakeTimers();
  const { agent, request } = setup();
  const turn = agent.turn.prompt({ input: "Find a track" });
  const result = turn.result();
  const expectation = expect(result).rejects.toMatchObject({ code: "turn_cancelled" });
  await turn.cancel();
  await turn.cancel();
  const id = (request.mock.calls[1][1] as { id: string }).id;
  expect(request.mock.calls.filter(([path]) => path.endsWith("/cancel"))).toHaveLength(1);
  expect(request.mock.calls[2].slice(0, 2)).toEqual([`/v1/agent/turns/${id}/cancel`, {}]);
  request
    .mockResolvedValueOnce({ id, status: "cancelling" })
    .mockResolvedValueOnce({ id, status: "cancelled" });
  await vi.advanceTimersByTimeAsync(3000);
  await expectation;
});

test("unmount stops polling without cancelling the durable cloud turn", async () => {
  vi.useFakeTimers();
  const { agent, request } = setup();
  const turn = agent.turn.prompt({ input: "Find a track" });
  const result = turn.result();
  const expectation = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  turn.dispose();
  await expectation;
  await vi.advanceTimersByTimeAsync(3000);
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/v1/auth/session", "/v1/agent/turns"]);
});

test("disconnect during the session check cannot submit after the check resolves", async () => {
  const { agent, request } = setup();
  let resolveSession!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
  );
  const turn = agent.turn.prompt({ input: "Find a track" });
  const result = turn.result();
  turn.dispose();
  resolveSession({ account: { grantId: "grant" } });
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(request).toHaveBeenCalledTimes(1);
});

test("releasing a watcher prevents events leaking into a new conversation", async () => {
  const { agent } = setup("completed");
  const events = vi.fn();
  const watcher = agent.events.watch();
  watcher.onEvent(events);
  watcher.off();
  await agent.turn.prompt({ input: "Find a track" }).result();
  expect(events).not.toHaveBeenCalled();
});

test("invalid input never reaches the broker", () => {
  const { agent, request } = setup();
  expect(() => agent.turn.prompt({ input: " " })).toThrow("16,000");
  expect(() => agent.turn.prompt({ input: "a".repeat(16001) })).toThrow("16,000");
  expect(request).not.toHaveBeenCalled();
});
