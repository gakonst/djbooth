/** Private container-only transport over the existing R2 binding. No public route. */
export async function snapshots(
  request: Request,
  bucket: R2Bucket,
  containerID: string,
): Promise<Response> {
  const url = new URL(request.url);
  const prefix = `playlist-snapshots/${containerID}/`;
  const path = url.pathname.slice("/snapshot/".length);
  if (path === "files" && request.method === "GET") {
    const result = await bucket.list({
      prefix: `${prefix}files/`,
      limit: 500,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    return Response.json({
      files: result.objects.map((object) => object.key.slice(`${prefix}files/`.length)),
      cursor: result.truncated ? result.cursor : null,
    });
  }
  const chunk = /^chunks\/([a-f0-9]{64})$/.exec(path);
  const file = path.startsWith("files/") ? decodeURIComponent(path.slice(6)) : undefined;
  if (!chunk && (!file || !validSnapshotPath(file)))
    return new Response("Invalid path", { status: 400 });
  const key = `${prefix}${chunk ? path : `files/${file}`}`;
  if (request.method === "GET" || request.method === "HEAD") {
    const object = request.method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response("body" in object ? (object as R2ObjectBody).body : null, {
      headers: { "content-length": String(object.size) },
    });
  }
  if (request.method !== "PUT") return new Response(null, { status: 405 });
  const limit = chunk ? 16 * 1024 * 1024 : 512 * 1024;
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length < 0 || length > limit || !request.body)
    return new Response("Invalid size", { status: 413 });
  // Fixed bounded chunks avoid Worker request-size limits for large audio or databases.
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== length || bytes.byteLength > limit)
    return new Response("Invalid size", { status: 413 });
  if (chunk) {
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== chunk[1]) return new Response("Checksum mismatch", { status: 422 });
  } else {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new Response("Invalid file", { status: 400 });
    }
    if (!validSnapshotFile(value)) return new Response("Invalid file", { status: 400 });
    for (const part of value.chunks) {
      const object = await bucket.head(`${prefix}chunks/${part.hash}`);
      if (object?.size !== part.size) return new Response("Missing chunk", { status: 409 });
    }
  }
  await bucket.put(key, bytes);
  return new Response(null, { status: 204 });
}
export function validSnapshotPath(path: string): boolean {
  return (
    path.length <= 900 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export function validSnapshotFile(
  value: unknown,
): value is { chunks: { hash: string; size: number }[] } {
  if (
    !value ||
    typeof value !== "object" ||
    !("chunks" in value) ||
    !Array.isArray(value.chunks) ||
    value.chunks.length > 4096
  )
    return false;
  return value.chunks.every(
    (part) =>
      part &&
      typeof part.hash === "string" &&
      /^[a-f0-9]{64}$/.test(part.hash) &&
      Number.isSafeInteger(part.size) &&
      part.size > 0 &&
      part.size <= 16 * 1024 * 1024,
  );
}
