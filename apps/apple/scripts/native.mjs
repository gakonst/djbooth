import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  pnpm native:diagnostics --device <id>                    Copy persistent phone diagnostics
  pnpm native:link --device <id> --operation <name> --arguments <json> Call Rust on the phone (hardware-test mode)
  pnpm --filter @gakonst/djbooth-apple check                  Compile macOS and iOS
  pnpm --filter @gakonst/djbooth-apple test                   Test the local store and sync package
  pnpm --filter @gakonst/djbooth-apple test:ui                Run native UI tests on the dedicated simulator

Options:
  --arguments-file <file> Read hardware command JSON from a file instead of exposing it in process arguments
  --simulator <uuid>       Use an existing simulator (never changes unrelated devices)
  --bootstrap-env <file>   Read initial cloud URL/token from a private JSON file; token is never bundled
  --launch-only            Relaunch an already installed physical-device app without rebuilding
  --offline-track <id>     Keep a cloud track on this device after it syncs (Debug builds)
  --offline-collection <id> Keep a cloud collection on this device as its tracks arrive (Debug builds)
  --dj-link               Enable DJ Link signing (requires Apple Multicast Networking approval)
  --universal-links       Enable direct HTTPS app links (requires Associated Domains signing)
  --snapshot              Export closed diagnostic files from the open hardware-test app
  --console               Stream physical-device app logs until it exits
  --physical              Build for iPhone without installing (build:ios)
  --optimized             Optimize Swift (-O) while retaining Debug features
  --dj-link-hardware-test Keep the Debug app awake and enable paired-device Rust commands
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
if (args.includes("--diagnostics-stall-probe")) appArguments.push("--diagnostics-stall-probe");
if (args.includes("--dj-link-hardware-test")) appArguments.push("--dj-link-hardware-test");
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
  // Requires a provisioning profile with Associated Domains. Otherwise HTTPS
  // invite pages still open the app through the registered djbooth:// scheme.
  if (args.includes("--universal-links")) parameters.push(`DJBOOTH_LINK_ENTITLEMENTS=DJBooth/${args.includes("--dj-link") ? "DJLinkUniversal" : "App"}.entitlements`);
  parameters.push(...optimizationSettings, `DJBOOTH_OFFLINE_COLLECTION=${offlineCollection ?? ""}`, "build");
  run("xcodebuild", parameters);
  const products = resolve(derived, "Build/Products", platform === "macos" ? configuration : `${configuration}-${physical ? "iphoneos" : "iphonesimulator"}`);
  if (platform === "ios" && existsSync(resolve(products, "DJBooth.app.dSYM"))) {
    const symbols = resolve(products, "DJBooth.app.dSYM");
    const uuids = run("xcrun", ["dwarfdump", "--uuid", symbols], { stdio: ["ignore", "pipe", "inherit"] });
    const uuid = /UUID: ([A-Fa-f0-9-]+)/.exec(uuids)?.[1];
    if (!uuid) throw new Error("Cannot identify iOS debug symbols");
    const archive = resolve(root, ".build/diagnostic-symbols", uuid);
    mkdirSync(archive, { recursive: true });
    cpSync(symbols, resolve(archive, "DJBooth.app.dSYM"), { recursive: true });
    cpSync(resolve(products, "DJBooth-build-id.txt"), resolve(archive, "build-id.txt"));
    writeFileSync(resolve(archive, "uuids.txt"), uuids + "\n");
  }
  return resolve(products, "DJBooth.app");
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

async function hardwareRequest(device, operation, input = {}) {
  const id = randomUUID();
  const directory = resolve(root, ".build/hardware-control", id);
  mkdirSync(directory, { recursive: true });
  const request = resolve(directory, "request.json");
  const response = resolve(directory, "response.json");
  const remote = "Library/Application Support/DJBooth/HardwareControl";
  const domain = ["--device", device, "--domain-type", "appDataContainer", "--domain-identifier", "xyz.gakonst.djbooth", "--timeout", "10"];
  writeFileSync(request, JSON.stringify({ id, operation, arguments: input, expires_ms: Date.now() + 60_000 }));
  // The app claims a command by deleting request.json. It can do that before
  // devicectl's post-copy metadata lookup, which reports error 7000 even
  // though the command ran. Always check its ID-specific reply; never resend.
  const upload = spawnSync("xcrun", ["devicectl", "device", "copy", "to", ...domain, "--source", request, "--destination", `${remote}/request.json`], { encoding: "utf8", timeout: 15_000 });
  if (upload.status !== 0) console.error("Device upload was not confirmed; checking the command acknowledgment without resending.");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 500));
    const copied = spawnSync("xcrun", ["devicectl", "device", "copy", "from", ...domain, "--source", `${remote}/response.json`, "--destination", response], { stdio: "ignore", timeout: 15_000 });
    if (copied.status !== 0) continue;
    const result = JSON.parse(readFileSync(response, "utf8"));
    if (result.id !== id) continue;
    return result;
  }
  throw new Error("No response from phone. Check it is open in hardware-test mode. Command outcome is unknown; do not automatically retry mutations.");
}

if (command === "test-kit") {
  run("swift", ["test", "--package-path", "DJBoothKit"]);
} else {
  await import("./project.mjs");
  switch (command) {
    case "link": {
      const device = value("--device");
      const operation = value("--operation");
      if (!device || !operation) throw new Error("Specify --device and --operation. The app must be open with --dj-link-hardware-test.");
      const inputFile = value("--arguments-file");
      if (inputFile && value("--arguments")) throw new Error("Use only one of --arguments or --arguments-file.");
      const input = JSON.parse(inputFile ? readFileSync(resolve(inputFile), "utf8") : value("--arguments") ?? "{}");
      const result = await hardwareRequest(device, operation, input);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      break;
    }
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
    case "diagnostics": {
      const device = value("--device");
      if (!device) throw new Error("Specify the paired iPhone with --device <id>.");
      const destination = resolve(root, ".build/diagnostics", String(Date.now()));
      mkdirSync(destination, { recursive: true });
      let source = "Library/Application Support/DJBooth/Diagnostics";
      if (args.includes("--snapshot")) {
        const result = await hardwareRequest(device, "diagnostics.snapshot");
        if (!result.ok) throw new Error(result.error ?? "Phone snapshot failed");
        const marker = "/Library/Application Support/";
        const path = result.value?.directory;
        if (typeof path !== "string" || !path.includes(marker)) throw new Error("Phone returned an invalid snapshot path");
        source = "Library/Application Support/" + path.split(marker)[1];
      }
      run("xcrun", ["devicectl", "device", "copy", "from", "--device", device,
        "--domain-type", "appDataContainer", "--domain-identifier", "xyz.gakonst.djbooth", "--timeout", "30",
        "--source", source, "--destination", destination], { timeout: 45_000 });
      console.log(`Phone diagnostics: ${destination}`);
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
      const device = value("--device");
      const id = device ?? simulator();
      const results = resolve(root, ".build/ui-tests", `${Date.now()}.xcresult`);
      mkdirSync(dirname(results), { recursive: true });
      run("xcodebuild", ["-project", "DJBooth.xcodeproj", "-scheme", "DJBooth-iOS", "-configuration", configuration,
        "-derivedDataPath", derived, "-destination", `platform=${device ? "iOS" : "iOS Simulator"},id=${id}`, "-resultBundlePath", results,
        "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=YES", ...(device ? ["-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration"] : ["CODE_SIGN_IDENTITY=-"]), ...optimizationSettings,
        ...(value("--only-testing") ? [`-only-testing:${value("--only-testing")}`] : []), "test"]);
      console.log(`UI test results: ${results}`);
      break;
    }
    default: throw new Error(`Unknown command: ${command}\n${help}`);
  }
}
