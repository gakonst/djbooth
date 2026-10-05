import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const arguments_ = process.argv.slice(2);
const lexical = arguments_.includes("--lexical");
const json = arguments_.includes("--json");
const query = arguments_
  .filter((value) => !value.startsWith("--"))
  .join(" ")
  .trim();
if (!query) {
  throw new Error(
    "Usage: node examples/production/query-house-taste.mjs [--lexical] [--json] <query>",
  );
}

const home = os.homedir();
const nodeCandidates = [path.join(home, ".bun/lib/node_modules/node/bin/node"), process.execPath];
const qmdCandidates = [
  path.join(home, ".bun/install/global/node_modules/@tobilu/qmd/dist/cli/qmd.js"),
  path.join(home, ".bun/install/global/node_modules/@tobilu/qmd/dist/qmd.js"),
];
const node = nodeCandidates.find(existsSync);
const qmd = qmdCandidates.find(existsSync);
if (!node || !qmd) throw new Error("QMD or its matching Node runtime is not installed");

const result = spawnSync(
  node,
  [
    qmd,
    lexical ? "search" : "query",
    query,
    "--collection",
    "music-ts-programmatic-production",
    "-n",
    "10",
    ...(json ? ["--json"] : ["--md"]),
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
process.stdout.write(result.stdout);
