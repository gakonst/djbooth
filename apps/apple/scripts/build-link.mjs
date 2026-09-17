import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sdk = process.env.PLATFORM_NAME;
if (!["iphoneos", "iphonesimulator"].includes(sdk)) throw new Error(`Unsupported Link platform: ${sdk}`);
const architectures = (process.env.ARCHS ?? "arm64").trim().split(/\s+/);
const output = process.env.BUILT_PRODUCTS_DIR;
if (!output) throw new Error("Run the Link build through the native Xcode project.");
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, IPHONEOS_DEPLOYMENT_TARGET: "17.0" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
// Bind diagnostics to exact source bytes, including uncommitted Swift/Rust edits.
const git = (args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot identify native build source");
  return result.stdout;
};
const revision = git(["rev-parse", "HEAD"]).trim();
const sourceFiles = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "apps/apple", "rust"]).split("\0").filter((path) => path && !path.endsWith("DJLinkMethods.swift"));
const fingerprint = createHash("sha256");
for (const path of sourceFiles.sort()) { fingerprint.update(path); fingerprint.update(readFileSync(resolve(root, path))); }
const buildID = `${revision}:${fingerprint.digest("hex")}:${sdk}:${process.env.CONFIGURATION ?? "unknown"}:${process.env.SWIFT_OPTIMIZATION_LEVEL ?? "unknown"}`;
const libraries = [];
for (const architecture of architectures) {
  const target = sdk === "iphoneos" && architecture === "arm64" ? "aarch64-apple-ios"
    : sdk === "iphonesimulator" && architecture === "arm64" ? "aarch64-apple-ios-sim"
    : sdk === "iphonesimulator" && architecture === "x86_64" ? "x86_64-apple-ios" : undefined;
  if (!target) throw new Error(`Unsupported Link architecture: ${sdk}/${architecture}`);
  const build = spawnSync("cargo", ["build", "--locked", "--manifest-path", "rust/Cargo.toml", "-p", "djbooth-mobile", "--target", target, "--release", "--message-format=json-render-diagnostics"], {
    cwd: root, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, IPHONEOS_DEPLOYMENT_TARGET: "17.0", DJBOOTH_BUILD_ID: buildID, CARGO_PROFILE_RELEASE_DEBUG: "1", CARGO_PROFILE_RELEASE_STRIP: "none" },
  });
  if (build.error) throw build.error;
  const messages = build.stdout.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const message of messages) {
    if (message.reason === "compiler-message" && message.message.rendered) process.stderr.write(message.message.rendered);
  }
  if (build.status !== 0) throw new Error(`cargo failed (${build.status})`);
  const artifact = messages.find((message) => message.reason === "compiler-artifact" && message.target.name === "djbooth_mobile");
  const bindings = messages.find((message) => message.reason === "build-script-executed" && message.package_id === artifact?.package_id);
  if (!bindings) throw new Error("Cargo did not return the generated DJ Link binding directory");
  const generated = readFileSync(resolve(bindings.out_dir, "DJLinkMethods.swift"), "utf8");
  const destination = resolve(root, "apps/apple/DJBooth/DJLinkMethods.swift");
  if (readFileSync(destination, "utf8") !== generated) writeFileSync(destination, generated);
  libraries.push(resolve(root, "rust/target", target, "release/libdjbooth_mobile.a"));
}
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "DJBooth-build-id.txt"), buildID + "\n");
run("xcrun", ["lipo", "-create", ...libraries, "-output", resolve(output, "libdjbooth_mobile.a")]);
