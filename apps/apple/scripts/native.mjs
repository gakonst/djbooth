import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const command = args.shift() ?? "help";
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
  return args[index + 1];
};
const help = `Native DJ Booth (requires macOS and Xcode 26+):
  pnpm --filter @gakonst/djbooth-apple dev                    Build and open the Mac app
  pnpm --filter @gakonst/djbooth-apple ios                    Build and open the dedicated iOS simulator
  pnpm --filter @gakonst/djbooth-apple ios --demo             Open an explicit sample library
  pnpm --filter @gakonst/djbooth-apple device --device <id>    Sign, install and launch on your paired iPhone
  pnpm --filter @gakonst/djbooth-apple check                  Compile macOS and iOS
  pnpm --filter @gakonst/djbooth-apple test                   Test the local store and sync package
  pnpm --filter @gakonst/djbooth-apple test:ui                Run native UI tests on the dedicated simulator

Options:
  --simulator <uuid>       Use an existing simulator (never changes unrelated devices)
  --bootstrap-env <file>   Read initial cloud URL/token from a private JSON file; token is never bundled
  --launch-only            Relaunch an already installed physical-device app without rebuilding
  --offline-track <id>     Keep a cloud track on this device after it syncs (Debug builds)
  --offline-collection <id> Keep a cloud collection on this device as its tracks arrive (Debug builds)
  --dj-link               Enable DJ Link signing (requires Apple Multicast Networking approval)
  --console               Stream physical-device app logs until it exits
  --physical              Build for iPhone without installing (build:ios)
  --optimized             Optimize Swift (-O) while retaining Debug features
  --demo                  Explicit DEBUG-only sample library
  --only-testing <test>    Restrict native UI tests to one Xcode test identifier
Environment:
  DJBOOTH_APPLE_TEAM       Override the Xcode signing team for Mac and device builds
  DJBOOTH_DERIVED_DATA     Override the native build directory
`;
if (command === "help" || args.includes("--help")) { console.log(help); process.exit(0); }
if (process.platform !== "darwin") {
  if (["build", "check", "test-kit"].includes(command)) {
    console.log("Native Apple checks require macOS with Xcode; skipped on this host."); process.exit(0);
  }
  throw new Error("The native app requires macOS and Xcode.");
}
const run = (binary, parameters, options = {}) => {
  const result = spawnSync(binary, parameters, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} exited with status ${result.status}`);
  return result.stdout?.toString().trim();
};
const json = (parameters) => JSON.parse(run("xcrun", parameters, { stdio: ["ignore", "pipe", "inherit"] }));
const derived = resolve(process.env.DJBOOTH_DERIVED_DATA ?? resolve(root, ".build/xcode"));
const configuration = "Debug";
const optimizationSettings = args.includes("--optimized") ? ["SWIFT_OPTIMIZATION_LEVEL=-O"] : [];
const appArguments = args.includes("--demo") ? ["--demo"] : [];
const offlineTrack = value("--offline-track");
if (offlineTrack) appArguments.push("--keep-offline", offlineTrack);
const offlineCollection = value("--offline-collection");
if (offlineCollection && offlineTrack) throw new Error("Choose either --offline-track or --offline-collection.");
if (offlineCollection) appArguments.push("--keep-offline-collection", offlineCollection);
const launchEnvironment = () => {
  const path = value("--bootstrap-env");
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  const allowed = new Set(["DJBOOTH_CLOUD_URL", "DJBOOTH_SYNC_TOKEN"]);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.entries(parsed).some(([key, item]) => !allowed.has(key) || typeof item !== "string")) {
    throw new Error("Bootstrap JSON must contain string DJBOOTH_CLOUD_URL and DJBOOTH_SYNC_TOKEN values only.");
  }
  return parsed;
};
const destination = (platform) => platform === "macos" ? "platform=macOS" : "generic/platform=iOS Simulator";
const build = (platform, options = {}) => {
  const physical = options.physical === true;
  const parameters = ["-project", "DJBooth.xcodeproj", "-scheme", `DJBooth-${platform === "macos" ? "macOS" : "iOS"}`,
    "-configuration", configuration, "-derivedDataPath", derived, "-destination", physical ? "generic/platform=iOS" : destination(platform)];
  if (physical || platform === "macos") {
    parameters.push("-allowProvisioningUpdates");
    if (physical) parameters.push("-allowProvisioningDeviceRegistration");
    if (process.env.DJBOOTH_APPLE_TEAM) parameters.push(`DEVELOPMENT_TEAM=${process.env.DJBOOTH_APPLE_TEAM}`);
  } else parameters.push("CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-");
  if (args.includes("--dj-link")) parameters.push("DJBOOTH_LINK_ENTITLEMENTS=DJBooth/DJLink.entitlements", "DJBOOTH_LINK_ENABLED=YES");
  parameters.push(...optimizationSettings, `DJBOOTH_OFFLINE_COLLECTION=${offlineCollection ?? ""}`, "build");
  run("xcodebuild", parameters);
  return resolve(derived, "Build/Products", platform === "macos" ? configuration : `${configuration}-${physical ? "iphoneos" : "iphonesimulator"}`, "DJBooth.app");
};
const simulator = () => {
  const devices = json(["simctl", "list", "devices", "available", "--json"]);
  const supplied = value("--simulator") ?? process.env.DJBOOTH_SIMULATOR_ID;
  let device;
  if (supplied) device = Object.values(devices.devices).flat().find((item) => item.udid === supplied);
  else {
    const runtimes = json(["simctl", "list", "runtimes", "--json"]).runtimes.filter((item) => item.isAvailable && item.identifier.includes("iOS")).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    const runtime = runtimes[0];
    if (!runtime) throw new Error("Install an iOS simulator runtime in Xcode Settings → Components.");
    device = (devices.devices[runtime.identifier] ?? []).find((item) => item.name === "DJ Booth iPhone");
    if (!device) {
      const types = json(["simctl", "list", "devicetypes", "--json"]).devicetypes;
      const type = [...types].reverse().find((item) => item.name.startsWith("iPhone") && !item.name.includes("Max"));
      if (!type) throw new Error("Xcode has no iPhone simulator device type.");
      const udid = run("xcrun", ["simctl", "create", "DJ Booth iPhone", type.identifier, runtime.identifier], { stdio: ["ignore", "pipe", "inherit"] });
      device = { udid, state: "Shutdown" };
    }
  }
  if (!device) throw new Error(`Simulator ${supplied} is unavailable.`);
  if (device.state !== "Booted") run("xcrun", ["simctl", "boot", device.udid]);
  run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  return device.udid;
};

if (command === "test-kit") {
  run("swift", ["test", "--package-path", "DJBoothKit"]);
} else {
  await import("./project.mjs");
  switch (command) {
    case "build": build(args[0] === "ios" ? "ios" : "macos", { physical: args.includes("--physical") }); break;
    case "check": build("macos"); build("ios"); break;
    case "run": {
      const platform = args[0] === "ios" ? "ios" : "macos";
      const app = build(platform);
      if (platform === "macos") {
        const executable = resolve(app, "Contents/MacOS/DJBooth");
        const processes = run("ps", ["-axo", "pid=,comm="], { stdio: ["ignore", "pipe", "inherit"] });
        for (const line of processes.split("\n")) {
          const match = /^\s*(\d+)\s+(.+)$/.exec(line);
          if (!match || match[2] !== executable) continue;
          try { process.kill(Number(match[1]), "SIGTERM"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        const environment = {
          DJBOOTH_REPOSITORY: resolve(root, "../.."),
          PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          ...launchEnvironment(),
        };
        const parameters = ["-n", "-a", app];
        for (const [key, item] of Object.entries(environment)) parameters.push("--env", `${key}=${item}`);
        run("open", [...parameters, "--args", ...appArguments]);
      } else {
        const id = simulator();
        run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", id]);
        run("xcrun", ["simctl", "install", id, app]);
        const environment = Object.fromEntries(Object.entries(launchEnvironment()).map(([key, item]) => [`SIMCTL_CHILD_${key}`, item]));
        run("xcrun", ["simctl", "launch", "--terminate-running-process", id, "xyz.gakonst.djbooth", ...appArguments], { env: { ...process.env, ...environment } });
      }
      break;
    }
    case "device": {
      const device = value("--device");
      if (!device) throw new Error("Specify your paired iPhone with --device <id>; inspect devices with xcrun devicectl list devices.");
      const environment = Object.fromEntries(Object.entries(launchEnvironment()).map(([key, item]) => [`DEVICECTL_CHILD_${key}`, item]));
      if (!args.includes("--launch-only")) {
        const app = build("ios", { physical: true });
        run("xcrun", ["devicectl", "device", "install", "app", "--device", device, app]);
      }
      run("xcrun", ["devicectl", "device", "process", "launch", "--device", device, "--terminate-existing", ...(args.includes("--console") ? ["--console"] : []), "xyz.gakonst.djbooth", ...appArguments], { env: { ...process.env, ...environment } });
      break;
    }
    case "test-ui": {
      const id = simulator();
      const results = resolve(root, ".build/ui-tests", `${Date.now()}.xcresult`);
      mkdirSync(dirname(results), { recursive: true });
      run("xcodebuild", ["-project", "DJBooth.xcodeproj", "-scheme", "DJBooth-iOS", "-configuration", configuration,
        "-derivedDataPath", derived, "-destination", `platform=iOS Simulator,id=${id}`, "-resultBundlePath", results,
        "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", ...optimizationSettings,
        ...(value("--only-testing") ? [`-only-testing:${value("--only-testing")}`] : []), "test"]);
      console.log(`UI test results: ${results}`);
      break;
    }
    default: throw new Error(`Unknown command: ${command}\n${help}`);
  }
}
