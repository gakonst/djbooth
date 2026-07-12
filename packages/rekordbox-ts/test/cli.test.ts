import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function runCli(...args: Array<string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("CLI process boundary", () => {
  it("serves the named CLI and machine-readable status", () => {
    const status = runCli("status", "--json");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      name: "@gakonst/rekordbox",
      phase: "complete-port",
    });

    const llms = runCli("--llms");
    expect(llms.status, llms.stderr).toBe(0);
    expect(llms.stdout).toContain("# rekordbox");
    expect(llms.stdout).toContain("rekordbox db table");
  });

  it("queries a plain database and rejects non-object filters", () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-cli-"));
    roots.push(root);
    const path = join(root, "plain.db");
    const database = new Database(path);
    database.exec("CREATE TABLE sample (ID TEXT PRIMARY KEY, Name TEXT)");
    database.prepare("INSERT INTO sample VALUES (?, ?)").run("1", "needle");
    database.close();

    const result = runCli(
      "db",
      "table",
      "sample",
      "--path",
      path,
      "--plain",
      "--filters",
      '{"Name":"needle"}',
      "--json",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ count: 1, table: "sample" });

    const sql = runCli(
      "db",
      "sql",
      "SELECT Name FROM sample WHERE ID = ?",
      "--path",
      path,
      "--plain",
      "--parameters",
      '["1"]',
      "--json",
    );
    expect(sql.status, sql.stderr).toBe(0);
    expect(JSON.parse(sql.stdout)).toMatchObject({ count: 1, rows: [{ Name: "needle" }] });

    const invalid = runCli(
      "db",
      "table",
      "sample",
      "--path",
      path,
      "--plain",
      "--filters",
      "[]",
      "--json",
    );
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}\n${invalid.stderr}`).toContain("filters must be a JSON object");
  });

  it("requires write mode for arbitrary SQL mutations", () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-cli-sql-"));
    roots.push(root);
    const path = join(root, "plain.db");
    const database = new Database(path);
    database.exec("CREATE TABLE sample (ID TEXT PRIMARY KEY)");
    database.close();

    const denied = runCli(
      "db",
      "sql",
      "INSERT INTO sample VALUES ('1')",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(denied.status).not.toBe(0);

    const allowed = runCli(
      "db",
      "sql",
      "INSERT INTO sample VALUES ('1')",
      "--path",
      path,
      "--plain",
      "--write",
      "--json",
    );
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ changes: 1 });
  });

  it("refuses database mutations without explicit write acknowledgement", () => {
    const result = runCli("db", "row", "create", "djmdArtist", "{}", "--plain", "--json");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("explicit --write flag");
  });
});
