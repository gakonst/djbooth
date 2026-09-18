import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import type { Env } from "../src/index.js";
import { evidencedRows, researchLinks, resolveTracklist } from "../src/resolver.js";

// Recorded community evidence, not a claim of perfect recognition or available media.
const benchmark = JSON.parse(
  await readFile(new URL("./fixtures/adam-ten-brunch-2026.json", import.meta.url), "utf8"),
) as {
  source: string;
  canonicalSource: string;
  supplied1001Candidate: { url: string; status: string };
  title: string;
  durationSeconds: number;
  evidenceURL: string;
  secondaryEvidenceURL: string;
  tracks: Array<{
    order: number;
    timestamp: string;
    artist?: string;
    title: string;
    isId?: boolean;
  }>;
};
const quotedRows = benchmark.tracks.map((row) => ({
  ...row,
  evidence: `${row.timestamp} ${row.artist ? row.artist + " - " : ""}${row.title}`,
}));
const page = (rows: typeof quotedRows) =>
  `${benchmark.title}\n${benchmark.source}\n${rows.map((row) => row.evidence).join("\n")}`;
const extraction = (rows: typeof quotedRows, matched = true) => ({
  matched,
  matchEvidence: benchmark.title,
  tracks: rows,
});

test("Barcelona reference preserves all 34 slots, six IDs, edit names, and a nonzero opening cue", () => {
  const rows = evidencedRows(extraction(quotedRows), page(quotedRows), benchmark.durationSeconds);
  expect(rows).toHaveLength(34);
  expect(rows.filter((row) => row.isId)).toHaveLength(6);
  expect(rows[0].startSeconds).toBe(30);
  expect(rows.at(-1)?.startSeconds).toBe(6960);
  expect(rows[10].title).toBe("Give Life Back to Music (ID Edit)");
  expect(rows[21].title).toBe("I Like That (NO STATIC Remix)");
  expect(rows[29].title).toBe("A.D.D. S.U.V. (DEDRO Edit)");
});

test("discovers this set's community evidence without admitting lookalike hosts", () => {
  expect(
    researchLinks(
      `${benchmark.evidenceURL} ${benchmark.secondaryEvidenceURL} https://whatstheid.com/mix/example https://groovesmaxxing.com.evil.test/set https://dancefloor.fm@127.0.0.1/set`,
    ),
  ).toEqual([
    benchmark.evidenceURL,
    benchmark.secondaryEvidenceURL,
    "https://whatstheid.com/mix/example",
  ]);
});

test("a sparse first secondary result cannot truncate Barcelona to six tracks", async () => {
  const sparse = "https://set79.com/tracklist/partial-barcelona";
  const unrelated = "https://groovesmaxxing.com/tracklists/a-different-performance";
  const visited: string[] = [];
  const response = await resolveTracklist(
    new Request("https://internal/resolve", {
      method: "POST",
      body: JSON.stringify({
        source: benchmark.source,
        context: { title: benchmark.title, durationSeconds: benchmark.durationSeconds },
      }),
    }),
    {
      BROWSER: {
        quickAction: async (_: string, options: { url: string }) => {
          visited.push(options.url);
          const url = new URL(options.url);
          const query = url.searchParams.get("q");
          const result = query?.includes("site:1001tracklists.com")
            ? "No matching performance found"
            : query
              ? `${sparse}\n${benchmark.evidenceURL}\n${unrelated}`
              : options.url === sparse
                ? page(quotedRows.slice(0, 6))
                : page(quotedRows);
          return Response.json({ success: true, result });
        },
      },
      AI: {
        run: async (_: string, input: { messages: Array<{ content: string }> }) => {
          const request = JSON.parse(input.messages[1].content);
          return {
            response: extraction(
              request.pageURL === sparse ? quotedRows.slice(0, 6) : quotedRows,
              request.pageURL !== unrelated && request.pageURL !== benchmark.source,
            ),
          };
        },
      },
    } as unknown as Env,
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    source: string;
    url: string;
    complete: boolean;
    tracks: Array<{ isId?: boolean; order: number }>;
  };
  expect(result.source).toBe(benchmark.source);
  expect(result.url).toBe(benchmark.evidenceURL);
  expect(result.complete).toBe(false);
  expect(result.tracks).toHaveLength(34);
  expect(result.tracks.filter((row) => row.isId)).toHaveLength(6);
  expect(result.tracks.map((row) => row.order)).toEqual(
    Array.from({ length: 34 }, (_, i) => i + 1),
  );
  expect(visited).toContain(unrelated);
});

test("Barcelona discovery uses its video ID and records the supplied 1001 candidate without inventing its rows", async () => {
  const queries: string[] = [];
  const visited: string[] = [];
  const response = await resolveTracklist(
    new Request("https://internal/resolve", {
      method: "POST",
      body: JSON.stringify({ source: benchmark.source, context: { title: benchmark.title } }),
    }),
    {
      BROWSER: {
        quickAction: async (_: string, options: { url: string }) => {
          const query = new URL(options.url).searchParams.get("q");
          if (query) {
            queries.push(query);
            return Response.json({
              success: true,
              result:
                query === '"ubifmmR-Mf8" site:1001tracklists.com'
                  ? benchmark.supplied1001Candidate.url
                  : query.endsWith(" tracklist")
                    ? benchmark.evidenceURL
                    : "",
            });
          }
          visited.push(options.url);
          if (options.url === benchmark.supplied1001Candidate.url)
            return new Response("Inaccessible candidate", { status: 403 });
          return Response.json({
            success: true,
            result: options.url === benchmark.evidenceURL ? page(quotedRows) : "No rows",
          });
        },
      },
      AI: {
        run: async (_: string, input: { messages: Array<{ content: string }> }) => {
          const request = JSON.parse(input.messages[1].content);
          return { response: extraction(quotedRows, request.pageURL === benchmark.evidenceURL) };
        },
      },
    } as unknown as Env,
  );
  expect(response.status).toBe(200);
  expect(queries[0]).toBe(`"${benchmark.canonicalSource}" site:1001tracklists.com/tracklist/`);
  expect(queries).toContain('"ubifmmR-Mf8" site:1001tracklists.com');
  expect(visited[0]).toBe(benchmark.supplied1001Candidate.url);
  expect(visited.filter((url) => url === benchmark.supplied1001Candidate.url)).toHaveLength(1);
  const result = (await response.json()) as { url: string; tracks: unknown[]; warnings: string[] };
  expect(result.url).toBe(benchmark.evidenceURL);
  expect(result.tracks).toHaveLength(34);
  expect(result.warnings.join(" ")).toContain("no matching tracklist could be verified");
});
