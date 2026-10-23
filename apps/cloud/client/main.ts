import { conversationAccess, FAST_AGENT_CONVERSATION_ID } from "../src/agent-permissions.js";
import { Client, Dialog, Transport, type Connection } from "nanocodex/connect";
import "./style.css";
import { phoneTools } from "../src/phone-tools";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const status = (message: string) => {
  el("status").textContent = message;
};
const fail = (error: unknown) => {
  el("error").textContent = error instanceof Error ? error.message : String(error);
};
async function main() {
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const headers = new Headers(body === undefined ? {} : { "content-type": "application/json" });
    // Each tab uses its own SDK grant, even if another tab changes the login cookie.
    if (path === "/v1/auth/session" || !path.startsWith("/v1/auth/")) {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
        grantId?: string;
        token?: string;
      } | null;
      if (!saved?.grantId || !saved.token) throw new Error("Sign in to access your library.");
      headers.set("authorization", `Bearer nc1.${saved.grantId}.${saved.token}`);
    }
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? "Request failed. Try again.");
    return value as T;
  }
  const config = await api<{ appId: string; api: string; dialog: string; mode?: string }>(
    "/v1/auth/config",
  );
  if (config.mode === "shared") {
    el("welcome-title").textContent = "Open DJ Booth";
    el("welcome-detail").textContent =
      "This shared library is available without signing in. Anyone with the URL can read it; changes require a private publishing token. Nanocodex agent and music connections are unavailable.";
    el("welcome").querySelector("fieldset")!.hidden = true;
    el("welcome").querySelector(".hint")!.textContent = "Open the library in the DJ Booth app.";
    const button = el<HTMLButtonElement>("connect");
    button.textContent = "Open shared library";
    button.onclick = async () => {
      try {
        const params = new URLSearchParams(location.search);
        const native = params.get("native") === "1";
        const challenge = params.get("challenge"),
          state = params.get("state");
        const callback = new URL(params.get("return") ?? "djbooth://connect");
        if (
          params.has("return") &&
          (callback.protocol !== "http:" ||
            callback.hostname !== "127.0.0.1" ||
            !callback.port ||
            callback.pathname !== "/connect" ||
            callback.username ||
            callback.password ||
            callback.search ||
            callback.hash)
        )
          throw new Error("Invalid CLI login callback.");
        if (
          native &&
          (!challenge ||
            !/^[a-f0-9]{64}$/.test(challenge) ||
            !state ||
            !/^[A-Za-z0-9_-]{32,128}$/.test(state))
        )
          throw new Error("Invalid app login request.");
        const result = await api<{ code?: string }>(
          "/v1/auth/connect",
          native ? { challenge } : {},
        );
        if (native && result.code) {
          callback.searchParams.set("code", result.code);
          callback.searchParams.set("state", state!);
          location.href = callback.href;
        } else status("Shared library ready. Open DJ Booth to browse and sync.");
      } catch (error) {
        fail(error);
      }
    };
    return;
  }
  // Use the SDK's public persistence adapter. The app never touches private SDK
  // fields or provider OAuth credentials. Session storage also isolates browser tabs.
  const key = `nanocodex:connect:${config.appId}:session`;
  const client = Client.create({
    appId: config.appId,
    session: sessionStorage,
    auth: {
      challenge: `${config.api}/v1/connect/auth/challenge`,
      verify: `${config.api}/v1/connect/auth`,
      logout: `${config.api}/v1/connect/auth/logout`,
      returnToken: true,
      resources: ["urn:nanocodex:agent:run"],
    },
    dialog: Dialog.popup({ host: config.dialog }),
    transport: Transport.http(config.api),
  });
  let agent = false;
  let active: Connection | undefined;
  let generation = 0;
  let polling: ReturnType<typeof setInterval> | undefined;
  const params = new URLSearchParams(location.search);
  const native = params.get("native") === "1";
  const challenge = params.get("challenge");
  const state = params.get("state");
  const returnTo = params.get("return");
  if (native && !returnTo) {
    el("welcome-title").textContent = "Sign in to DJ Booth";
    el("welcome-detail").textContent =
      "Continue with your phone number in Nanocodex. Approve your agent to read this phone's library and run DJBooth downloads, analysis, and publishing in your private cloud workspace. You can also connect your music services below.";
  }
  const callback = returnTo ? new URL(returnTo) : new URL("djbooth://connect");
  if (
    returnTo &&
    (callback.protocol !== "http:" ||
      callback.hostname !== "127.0.0.1" ||
      !callback.port ||
      callback.pathname !== "/connect" ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash)
  )
    throw new Error("Invalid CLI login callback.");
  if (
    native &&
    (!challenge ||
      !/^[a-f0-9]{64}$/.test(challenge) ||
      !state ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(state))
  )
    throw new Error("Invalid app login request. Reopen login from DJ Booth.");

  async function connected(connection: Connection) {
    const current = ++generation;
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
      grantId: string;
      token: string;
    } | null;
    if (!stored || stored.grantId !== connection.grant.id)
      throw new Error("Connect session is unavailable. Please sign in again.");
    const result = await api<{ account: { id: string }; code?: string }>("/v1/auth/connect", {
      grantId: stored.grantId,
      token: stored.token,
      ...(native ? { challenge } : {}),
    });
    if (current !== generation) return;
    active = connection;
    el("welcome").hidden = true;
    el("workspace").hidden = false;
    el("logout").hidden = false;
    el("providers").textContent =
      `Music connections: ${connection.grant.capabilities.filter((v) => /spotify|soundcloud/.test(v)).join(", ") || "None"}`;
    if (native && result.code) {
      const url = new URL(callback);
      url.searchParams.set("code", result.code);
      url.searchParams.set("state", state!);
      const link = el<HTMLAnchorElement>("return");
      link.href = url.href;
      link.hidden = false;
      status("Connected. Return to DJ Booth to open your library.");
      location.href = url.href;
      return;
    }
    status("Opening your agent…");
    agent = true;
    status("Ready. Ask about your music or import a playlist below.");
    await refreshImports();
    if (polling) clearInterval(polling);
    polling = setInterval(() => {
      void refreshImports().catch(fail);
    }, 10_000);
  }
  async function connect() {
    el("error").textContent = "";
    el<HTMLButtonElement>("connect").disabled = true;
    el<HTMLButtonElement>("manage").disabled = true;
    generation++;
    agent = false;
    active = undefined;
    el("conversation").replaceChildren();
    if (polling) clearInterval(polling);
    status("Waiting for Nanocodex…");
    try {
      // Reserve the SDK popup during the tap. Hashing the signed phone tool
      // catalog is asynchronous and otherwise loses Safari's user activation.
      client.dialog.showWallet?.();
      const connection = await client.connection.connect({
        conversationId: FAST_AGENT_CONVERSATION_ID,
        tools: phoneTools,
        authorization: "hosted",
        permission: "agent.run",
        capabilities: {
          cloudAccounts: {
            ...(el<HTMLInputElement>("spotify").checked ? { spotify: true } : {}),
            ...(el<HTMLInputElement>("soundcloud").checked ? { soundcloud: true } : {}),
          },
          agent: conversationAccess,
        },
      });
      await connected(connection);
    } catch (error) {
      client.dialog.hideWallet?.();
      status("");
      fail(error);
    } finally {
      el<HTMLButtonElement>("connect").disabled = false;
      el<HTMLButtonElement>("manage").disabled = false;
    }
  }
  el("connect").onclick = () => {
    void connect();
  };
  el("manage").onclick = () => {
    el("welcome").hidden = false;
    el("workspace").hidden = true;
    status("Choose your music connections, then continue.");
  };
  el("logout").onclick = async () => {
    generation++;
    agent = false;
    active = undefined;
    if (polling) clearInterval(polling);
    sessionStorage.removeItem(key);
    el("conversation").replaceChildren();
    el("imports").replaceChildren();
    el("workspace").hidden = true;
    el("welcome").hidden = false;
    el("logout").hidden = true;
    try {
      await api("/v1/auth/logout", {});
      await client.account.logout();
      status("Signed out.");
    } catch (error) {
      fail(error);
    }
  };
  el<HTMLFormElement>("prompt").onsubmit = async (event) => {
    event.preventDefault();
    if (!agent || !active) return;
    const current = generation,
      input = el<HTMLTextAreaElement>("message").value.trim();
    if (!input) return;
    el<HTMLButtonElement>("send").disabled = true;
    el("error").textContent = "";
    appendMessage("You", input);
    el<HTMLTextAreaElement>("message").value = "";
    status("Your agent is working…");
    try {
      // Checking the cookie account prevents another tab's login from coupling this
      // agent's provider access to a different user's library session.
      const session = await api<{ account: { grantId: string } }>("/v1/auth/session");
      if (session.account.grantId !== active.grant.id)
        throw new Error("Your account changed in another tab. Sign in again.");
      let result = await api<{ id: string; status: string; finalMessage?: string; error?: string }>(
        "/v1/agent/turns",
        { id: crypto.randomUUID(), input },
      );
      while (result.status === "running" && current === generation) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result = await api(`/v1/agent/turns/${result.id}`);
      }
      if (result.status !== "completed")
        throw new Error(result.error ?? "Agent stopped before completing the request.");
      if (current === generation) {
        appendMessage("DJ Booth", result.finalMessage ?? "");
        status("");
      }
    } catch (error) {
      if (current === generation) {
        status("");
        fail(error);
      }
    } finally {
      el<HTMLButtonElement>("send").disabled = false;
    }
  };
  function appendMessage(who: string, message: string) {
    const p = document.createElement("p");
    p.textContent = `${who}\n${message}`;
    el("conversation").append(p);
  }
  async function refreshImports() {
    const current = generation;
    const result = await api<{
      jobs: { source: string; phase: string; current: number; total: number }[];
    }>("/v1/imports");
    if (current !== generation) return;
    el("imports").replaceChildren(
      ...result.jobs.map((job) => {
        const p = document.createElement("p");
        p.textContent = `${job.phase} · ${job.current}/${job.total} · ${job.source}`;
        return p;
      }),
    );
  }
  el<HTMLFormElement>("import").onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api("/v1/imports", {
        id: crypto.randomUUID(),
        source: el<HTMLInputElement>("source").value,
      });
      await refreshImports();
    } catch (error) {
      fail(error);
    }
  };
  if (!native) {
    status("Restoring your connection…");
    try {
      const connection = await client.connection.reconnect({
        authorization: "hosted",
        permission: "agent.run",
      });
      if (connection) await connected(connection);
      else status("");
    } catch (error) {
      status("");
      fail(error);
    }
  }
}
void main().catch(fail);
