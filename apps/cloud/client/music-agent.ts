import type { Agent, AgentEvent, AgentTurn } from "nanocodex-connect-embed/headless";

export type MusicAgentAPI = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
type TurnStatus = { id: string; status: string; finalMessage?: string; error?: string };

/** Adapt the grant-bound DJ Booth broker to the SDK's public Agent contract.
 * The broker still owns DJ instructions, tool attachment, and authorization.
 */
export function createMusicAgent(api: MusicAgentAPI, grantId: string): Agent {
  const listeners = new Set<(event: AgentEvent) => void>();
  let sequence = 0;
  return {
    sessionId: grantId,
    events: {
      watch() {
        const owned = new Set<(event: AgentEvent) => void>();
        return {
          onEvent(listener) {
            owned.add(listener);
            listeners.add(listener);
            return () => {
              owned.delete(listener);
              listeners.delete(listener);
            };
          },
          off() {
            for (const listener of owned) listeners.delete(listener);
            owned.clear();
          },
        };
      },
    },
    turn: {
      prompt({ input }): AgentTurn {
        if (!input.trim() || input.length > 16000)
          throw new Error("Enter a message of up to 16,000 characters.");
        const id = crypto.randomUUID();
        const abort = new AbortController();
        const signal = abort.signal;
        // One submission and one identity per turn. Ambiguous writes are never retried.
        const submitted = (async () => {
          const session = await api<{ account: { grantId: string } }>(
            "/v1/auth/session",
            undefined,
            signal,
          );
          signal.throwIfAborted();
          if (session.account.grantId !== grantId)
            throw new Error("Your account changed in another tab. Sign in again.");
          const result = await api<TurnStatus>("/v1/agent/turns", { id, input }, signal);
          signal.throwIfAborted();
          for (const listener of listeners)
            listener({
              request_id: grantId,
              seq: ++sequence,
              type: "run.started",
              payload: { turn_id: id },
            });
          return result;
        })();
        let completion: ReturnType<AgentTurn["result"]> | undefined;
        let cancellation: Promise<unknown> | undefined;
        return {
          historyEntryId: `managed-user-${id}`,
          steer: async () => {
            throw new Error(
              "Wait for Booth to finish, or stop this turn before sending another message.",
            );
          },
          cancel() {
            cancellation ??= submitted.then((result) => {
              signal.throwIfAborted();
              if (result.status !== "running" && result.status !== "cancelling") return result;
              return api<TurnStatus>(`/v1/agent/turns/${result.id}/cancel`, {}, signal);
            });
            return cancellation;
          },
          result() {
            completion ??= (async () => {
              let result = await submitted;
              while (result.status === "running" || result.status === "cancelling") {
                await pause(1500, signal);
                result = await api<TurnStatus>(`/v1/agent/turns/${result.id}`, undefined, signal);
              }
              signal.throwIfAborted();
              if (result.status === "cancelled")
                throw Object.assign(new Error("Stopped."), { code: "turn_cancelled" });
              if (result.status !== "completed")
                throw new Error(result.error ?? "Agent stopped before completing the request.");
              return { finalMessage: result.finalMessage ?? "", dispose() {} };
            })();
            return completion;
          },
          dispose() {
            abort.abort();
          },
        };
      },
    },
  };
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    function stop() {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}
