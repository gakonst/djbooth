import { DurableObject } from "cloudflare:workers";

/** One live room per crew. D1 owns playlist data; these are invalidations only. */
export class CrewRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Use WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ expires: Date.now() + 5 * 60_000 });
    pair[1].send(JSON.stringify({ type: "changed" }));
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async changed(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "changed" }));
      } catch {
        socket.close(1011, "Reconnect");
      }
    }
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
    else socket.close(1008, "Read-only updates");
  }
  webSocketClose(socket: WebSocket, code: number): void {
    socket.close(code);
  }
  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Reconnect");
  }
  async alarm(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment().expires <= Date.now())
        socket.close(1000, "Refresh authorization");
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}
