import { AuthError, CONNECT_APP_ID, credential } from "./auth.js";
import type { Env } from "./index.js";

/** Optional broker contract. Deployment must supply a service which validates the
 * original grant and connection, streams multipart to SoundCloud, and durably
 * deduplicates Idempotency-Key (including unknown upstream outcomes). No OAuth
 * secrets enter DJBooth. Absent that service, fail before uploading any audio. */
export async function recordingUpload(
  request: Request,
  env: Env,
  connection: string,
  readJSON: (request: Request) => Promise<unknown>,
  readMedia?: (hash: string) => Promise<Response>,
): Promise<Response> {
  const unavailable =
    "SoundCloud recording uploads need the streaming connector service. Your recording is saved and can be exported.";
  if (request.method === "GET")
    return Response.json({
      available: Boolean(env.SOUNDCLOUD_UPLOAD_SERVICE),
      reason: env.SOUNDCLOUD_UPLOAD_SERVICE ? null : unavailable,
    });
  if (request.method !== "POST") throw new AuthError(405, "Use GET or POST for recording uploads.");
  if (!env.SOUNDCLOUD_UPLOAD_SERVICE || !readMedia) throw new AuthError(503, unavailable);
  const value = (await readJSON(request)) as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.audioHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.audioHash) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 255 ||
    typeof value.description !== "string" ||
    [...value.description].length > 4000 ||
    typeof value.uploadID !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(value.uploadID)
  )
    throw new AuthError(
      400,
      "Provide audio hash, title, complete tracklist (up to 4,000 characters), and upload ID.",
    );
  const audio = await readMedia(value.audioHash);
  if (!audio.ok || !audio.body)
    throw new AuthError(409, "Upload the complete recorded audio first.");
  const size = Number(audio.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0 || size > 4_000_000_000) {
    await audio.body.cancel();
    throw new AuthError(413, "SoundCloud accepts audio files up to 4 GB.");
  }
  const boundary = `djbooth-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const fields = {
    "track[title]": value.title,
    "track[description]": value.description,
    "track[sharing]": "private",
  };
  const prefix = encoder.encode(
    Object.entries(fields)
      .map(
        ([key, text]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${text}\r\n`,
      )
      .join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="track[asset_data]"; filename="master.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = audio.body.getReader();
  // Cloud media is content-addressed but generic; verify the export container
  // before calling the external publisher and preserve these exact bytes.
  const initial: Uint8Array[] = [];
  let initialSize = 0;
  while (initialSize < 12) {
    const part = await reader.read();
    if (part.done) break;
    initial.push(part.value);
    initialSize += part.value.length;
  }
  const magic = new Uint8Array(12);
  let copied = 0;
  for (const part of initial) {
    const count = Math.min(part.length, 12 - copied);
    magic.set(part.subarray(0, count), copied);
    copied += count;
    if (copied === 12) break;
  }
  if (
    new TextDecoder().decode(magic.subarray(0, 4)) !== "RIFF" ||
    new TextDecoder().decode(magic.subarray(8, 12)) !== "WAVE"
  ) {
    await reader.cancel();
    throw new AuthError(415, "Prepare the recording as a WAV file before publishing.");
  }
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(prefix);
        return;
      }
      if (initial.length) {
        controller.enqueue(initial.shift()!);
        return;
      }
      try {
        const part = await reader.read();
        if (part.done) {
          reader.releaseLock();
          controller.enqueue(suffix);
          controller.close();
        } else controller.enqueue(part.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  const token = credential(request)?.split(".")[2];
  if (!token) {
    await body.cancel();
    throw new AuthError(401, "Sign in to Nanocodex.");
  }
  const uploadRequest: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    redirect: "manual",
    signal: request.signal,
    headers: {
      authorization: `Bearer ${token}`,
      origin: new URL(request.url).origin,
      "x-nanocodex-app-id": CONNECT_APP_ID,
      "idempotency-key": value.uploadID,
      "x-djbooth-audio-sha256": value.audioHash,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(prefix.length + size + suffix.length),
    },
    body,
  };
  const upstream = await env.SOUNDCLOUD_UPLOAD_SERVICE.fetch(
    new Request(
      `https://soundcloud-upload.internal/v1/connections/${encodeURIComponent(connection)}/tracks`,
      uploadRequest,
    ),
  );
  // Never retry this mutation: only the broker can reconcile an ambiguous upload.
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new AuthError(
      upstream.status === 401 || upstream.status === 403 ? upstream.status : 502,
      "SoundCloud upload did not complete. Check the account before retrying; the saved audio and upload ID are retained.",
    );
  }
  const result = (await upstream.json()) as {
    permalink_url?: string;
    urn?: string;
    id?: number;
    state?: string;
  };
  const remoteID = result.urn ?? (result.id ? String(result.id) : "");
  if (!remoteID)
    throw new AuthError(
      502,
      "The upload response has no track ID. Check SoundCloud before retrying.",
    );
  let link: URL;
  try {
    link = new URL(result.permalink_url ?? "");
  } catch {
    throw new AuthError(
      502,
      "The upload response is incomplete. Check SoundCloud before retrying.",
    );
  }
  if (
    link.protocol !== "https:" ||
    link.hostname !== "soundcloud.com" ||
    link.username ||
    link.password
  )
    throw new AuthError(502, "The upload response is invalid. Check SoundCloud before retrying.");
  return Response.json(
    {
      url: link.href,
      id: remoteID,
      state: result.state ?? "processing",
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
