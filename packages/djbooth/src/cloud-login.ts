import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function cloudCredentialPath(endpoint: URL): string {
  return join(homedir(), ".config", "djbooth", "cloud", `${hash(endpoint.origin)}.json`);
}
export async function savedCloudToken(endpoint: URL): Promise<string | undefined> {
  const path = cloudCredentialPath(endpoint);
  try {
    const info = await stat(path);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      throw new Error("Cloud login file must be private (chmod 600)");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.endpoint !== endpoint.origin || typeof value.token !== "string")
      throw new Error("Invalid cloud login; run cloud login again");
    return value.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
export async function forgetCloudLogin(endpoint: URL): Promise<void> {
  await rm(cloudCredentialPath(endpoint), { force: true });
}
function openBrowser(url: string): void {
  const binary =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const child = spawn(binary, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
/** The loopback callback receives a one-time code, never a grant or provider token. */
export async function loginCloud(
  endpoint: URL,
  options: {
    open?: (url: string) => void;
    fetch?: typeof fetch;
    save?: boolean;
    timeoutMs?: number;
    onProgress?: (phase: string, url?: string) => void;
  } = {},
): Promise<{ accountId: string; credentialFile?: string }> {
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(32).toString("base64url");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not open login callback");
  const callback = new URL(`http://127.0.0.1:${address.port}/connect`);
  const login = new URL(endpoint);
  login.searchParams.set("native", "1");
  login.searchParams.set("challenge", hash(verifier));
  login.searchParams.set("state", state);
  login.searchParams.set("return", callback.href);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress = (phase: string, url?: string) => {
    try {
      options.onProgress?.(phase, url);
    } catch {
      /* diagnostic only */
    }
  };
  const updates = setInterval(() => progress("waiting"), 15_000);
  try {
    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Login timed out. Run cloud login to try again.")),
        options.timeoutMs ?? 300_000,
      );
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", callback);
        if (
          request.method !== "GET" ||
          request.headers.host !== callback.host ||
          url.pathname !== "/connect" ||
          url.searchParams.get("state") !== state ||
          !/^[a-f0-9]{64}$/.test(url.searchParams.get("code") ?? "")
        ) {
          response.writeHead(400);
          response.end("Invalid login callback");
          return;
        }
        response.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        response.end("Login received. Return to your terminal.");
        resolve(url.searchParams.get("code")!);
      });
      progress("login", login.href);
      (options.open ?? openBrowser)(login.href);
    });
    progress("verify");
    const response = await (options.fetch ?? fetch)(new URL("/v1/auth/exchange", endpoint), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Login verification failed. Run cloud login again.");
    const value = (await response.json()) as { token: string; account: { id: string } };
    if (
      !/^nc1\.0x[a-fA-F0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(value.token) ||
      !/^nc_[a-f0-9]{64}$/.test(value.account?.id)
    )
      throw new Error("Invalid login response");
    const path = cloudCredentialPath(endpoint);
    if (options.save !== false) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(8).toString("hex")}`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            endpoint: endpoint.origin,
            accountId: value.account.id,
            token: value.token,
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    progress("complete");
    return {
      accountId: value.account.id,
      ...(options.save !== false ? { credentialFile: path } : {}),
    };
  } finally {
    clearTimeout(timer);
    clearInterval(updates);
    server.closeAllConnections();
    server.close();
  }
}
