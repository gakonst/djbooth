import { setTimeout as delay } from "node:timers/promises";

interface Plan {
  accountId: string;
  entities: { kind: string; total: number; deleted: number }[];
  imports: number;
  objects: { id: number; name: string; total: number; bytes: number }[];
}
export async function migrateCloudLegacy(
  options: {
    endpoint: URL;
    token: string;
    dryRun?: boolean;
    onProgress?: (phase: string, current: number, total: number) => void;
  },
  request: typeof fetch = fetch,
) {
  let progress = { phase: "inspect", current: 0, total: 1 };
  const emit = (phase: string, current: number, total: number) => {
    progress = { phase, current, total };
    try {
      options.onProgress?.(phase, current, total);
    } catch {
      /* diagnostic only */
    }
  };
  async function call<T>(body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await request(new URL("/v1/migrations/legacy", options.endpoint), {
          method: body ? "POST" : "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(120_000),
        });
        if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
          await response.body?.cancel();
          await delay(500 * 2 ** attempt);
          continue;
        }
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            `Legacy migration failed (${response.status}): ${value.error?.message ?? "request rejected"}`,
          );
        return value as T;
      } catch (error) {
        if (
          attempt >= 3 ||
          (error instanceof Error && error.message.startsWith("Legacy migration failed"))
        )
          throw error;
        await delay(500 * 2 ** attempt);
      }
    }
  }
  emit("inspect", 0, 1);
  const heartbeat = setInterval(
    () => emit(progress.phase, progress.current, progress.total),
    10_000,
  );
  try {
    const plan = await call<Plan>();
    if (options.dryRun) {
      emit("complete", 1, 1);
      return { dryRun: true, ...plan };
    }
    let copiedObjects = 0,
      reusedObjects = 0,
      copiedEntities = 0,
      reusedEntities = 0;
    const conflicts: string[] = [];
    for (const task of plan.objects) {
      let cursor: string | null = null,
        current = 0;
      emit(task.name, current, task.total);
      do {
        const batch: { copied: number; reused: number; count: number; cursor: string | null } =
          await call({ phase: "objects", task: task.id, ...(cursor ? { cursor } : {}) });
        copiedObjects += batch.copied;
        reusedObjects += batch.reused;
        current += batch.count;
        cursor = batch.cursor;
        emit(task.name, current, task.total);
      } while (cursor);
    }
    let after = 0,
      current = 0;
    const total = plan.entities.reduce((sum, item) => sum + item.total, 0);
    emit("library", current, total);
    while (true) {
      const batch = await call<{
        copied: number;
        reused: number;
        conflicts: string[];
        count: number;
        after: number;
        done: boolean;
      }>({ phase: "entities", after });
      copiedEntities += batch.copied;
      reusedEntities += batch.reused;
      conflicts.push(...batch.conflicts);
      current += batch.count;
      after = batch.after;
      emit("library", current, total);
      if (batch.done) break;
    }
    emit("imports", 0, plan.imports);
    const imports = await call<{ copied: number; count: number; conflicts: string[] }>({
      phase: "imports",
    });
    conflicts.push(...imports.conflicts.map((id) => `import:${id}`));
    emit(conflicts.length ? "needs-attention" : "complete", total, total);
    return {
      ...plan,
      copiedObjects,
      reusedObjects,
      copiedEntities,
      reusedEntities,
      copiedImports: imports.copied,
      conflicts,
    };
  } finally {
    clearInterval(heartbeat);
  }
}
