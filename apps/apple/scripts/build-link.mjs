import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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
const libraries = [];
for (const architecture of architectures) {
  const target = sdk === "iphoneos" && architecture === "arm64" ? "aarch64-apple-ios"
    : sdk === "iphonesimulator" && architecture === "arm64" ? "aarch64-apple-ios-sim"
    : sdk === "iphonesimulator" && architecture === "x86_64" ? "x86_64-apple-ios" : undefined;
  if (!target) throw new Error(`Unsupported Link architecture: ${sdk}/${architecture}`);
  run("cargo", ["build", "--locked", "--manifest-path", "rust/Cargo.toml", "-p", "djbooth-mobile", "--target", target, "--release"]);
  libraries.push(resolve(root, "rust/target", target, "release/libdjbooth_mobile.a"));
}
mkdirSync(output, { recursive: true });
run("xcrun", ["lipo", "-create", ...libraries, "-output", resolve(output, "libdjbooth_mobile.a")]);
