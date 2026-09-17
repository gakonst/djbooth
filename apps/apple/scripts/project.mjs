import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectDirectory = resolve(root, "DJBooth.xcodeproj");
const objects = [];
const id = (name) => createHash("sha256").update(`djbooth:${name}`).digest("hex").slice(0, 24).toUpperCase();
const quote = (value) => JSON.stringify(String(value));
const array = (values) => `(${values.join(", ")})`;
const object = (name, properties) => {
  objects.push(`${id(name)} = { ${properties} };`);
  return id(name);
};
const settings = (values) => `{ ${Object.entries(values).map(([key, value]) => `${quote(key)} = ${Array.isArray(value) ? array(value.map(quote)) : quote(value)};`).join(" ")} }`;
const configurationList = (name, base, debug = {}) => {
  const configurations = ["Debug", "Release"].map((mode) => object(`${name}.${mode}`, `isa = XCBuildConfiguration; name = ${mode}; buildSettings = ${settings({
    ...base,
    SWIFT_OPTIMIZATION_LEVEL: mode === "Debug" ? "-Onone" : "-O",
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: mode === "Debug" ? "$(inherited) DEBUG" : "$(inherited)",
    DEBUG_INFORMATION_FORMAT: mode === "Debug" ? "dwarf" : "dwarf-with-dsym",
    ENABLE_TESTABILITY: mode === "Debug" ? "YES" : "NO",
    ONLY_ACTIVE_ARCH: mode === "Debug" ? "YES" : "NO",
    ...(mode === "Debug" ? debug : {}),
  })};`));
  return object(`${name}.configurations`, `isa = XCConfigurationList; buildConfigurations = ${array(configurations)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;`);
};
const sourceFiles = async (directory) => (await readdir(resolve(root, directory))).filter((name) => name.endsWith(".swift")).sort().map((name) => `${directory}/${name}`);
const appSources = await sourceFiles("DJBooth");
const testSources = await sourceFiles("DJBoothUITests");
const fileReferences = new Map();
for (const path of [...appSources, ...testSources, "DJBooth/Info.iOS.plist", "DJBooth/Info.macOS.plist", "DJBooth/Info.Debug.iOS.plist", "DJBooth/Info.Debug.macOS.plist", "DJBooth/Assets.xcassets"]) {
  const type = path.endsWith(".swift") ? "sourcecode.swift" : path.endsWith(".plist") ? "text.plist.xml" : "folder.assetcatalog";
  fileReferences.set(path, object(`file.${path}`, `isa = PBXFileReference; lastKnownFileType = ${type}; path = ${quote(path)}; sourceTree = SOURCE_ROOT;`));
}
const packageReference = object("package", "isa = XCLocalSwiftPackageReference; relativePath = DJBoothKit;");
const products = [];
const targets = [];
const team = "C3Q4NN5ZQ8";
const common = {
  SWIFT_VERSION: "6.0", CLANG_ENABLE_MODULES: "YES", CODE_SIGN_STYLE: "Automatic",
  DEVELOPMENT_TEAM: team, GENERATE_INFOPLIST_FILE: "YES", CURRENT_PROJECT_VERSION: "1",
  MARKETING_VERSION: "0.1.0", ENABLE_USER_SCRIPT_SANDBOXING: "YES",
};
for (const platform of ["macOS", "iOS"]) {
  const targetName = `DJBooth-${platform}`;
  const testTargetName = `DJBoothUITests-${platform}`;
  const platformSettings = platform === "iOS" ? {
    SDKROOT: "iphoneos", SUPPORTED_PLATFORMS: "iphoneos iphonesimulator", IPHONEOS_DEPLOYMENT_TARGET: "17.0",
    TARGETED_DEVICE_FAMILY: "1,2", SUPPORTS_MACCATALYST: "NO", SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD: "NO",
  } : { SDKROOT: "macosx", SUPPORTED_PLATFORMS: "macosx", MACOSX_DEPLOYMENT_TARGET: "14.0" };
  const product = object(`${targetName}.product`, "isa = PBXFileReference; explicitFileType = wrapper.application; path = DJBooth.app; sourceTree = BUILT_PRODUCTS_DIR;");
  products.push(product);
  const sources = appSources.map((path) => object(`${targetName}.build.${path}`, `isa = PBXBuildFile; fileRef = ${fileReferences.get(path)};`));
  const sourcePhase = object(`${targetName}.sources`, `isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ${array(sources)}; runOnlyForDeploymentPostprocessing = 0;`);
  const packageProduct = object(`${targetName}.package`, `isa = XCSwiftPackageProductDependency; package = ${packageReference}; productName = DJBoothKit;`);
  const packageBuild = object(`${targetName}.packageBuild`, `isa = PBXBuildFile; productRef = ${packageProduct};`);
  const frameworks = object(`${targetName}.frameworks`, `isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (${packageBuild}); runOnlyForDeploymentPostprocessing = 0;`);
  const assetBuild = object(`${targetName}.assets`, `isa = PBXBuildFile; fileRef = ${fileReferences.get("DJBooth/Assets.xcassets")};`);
  const resources = object(`${targetName}.resources`, `isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (${assetBuild}); runOnlyForDeploymentPostprocessing = 0;`);
  const linkPhase = platform === "iOS" ? object(`${targetName}.linkBuild`, `isa = PBXShellScriptBuildPhase; buildActionMask = 2147483647; files = (); inputPaths = (); outputPaths = (); alwaysOutOfDate = 1; runOnlyForDeploymentPostprocessing = 0; shellPath = /bin/sh; shellScript = ${quote('export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nnode "$SRCROOT/scripts/build-link.mjs"')}; name = "Build embedded DJ Link";`) : null;
  const configuration = configurationList(targetName, {
    ...common, ...platformSettings, PRODUCT_NAME: "DJBooth", PRODUCT_MODULE_NAME: "DJBooth",
    PRODUCT_BUNDLE_IDENTIFIER: "xyz.gakonst.djbooth", INFOPLIST_FILE: `DJBooth/Info.${platform}.plist`,
    INFOPLIST_KEY_CFBundleDisplayName: "DJ Booth", INFOPLIST_KEY_LSApplicationCategoryType: "public.app-category.music",
    ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon", ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: "AccentColor",
    LD_RUNPATH_SEARCH_PATHS: ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../Frameworks"],
    ...(platform === "iOS" ? {
      ENABLE_USER_SCRIPT_SANDBOXING: "NO", SWIFT_OBJC_BRIDGING_HEADER: "DJBooth/DJLinkBridge.h",
      LIBRARY_SEARCH_PATHS: ["$(inherited)", "$(BUILT_PRODUCTS_DIR)"],
      OTHER_LDFLAGS: ["$(inherited)", "-ldjbooth_mobile", "-lc++", "-liconv", "-framework", "Security", "-framework", "SystemConfiguration"],
      CODE_SIGN_ENTITLEMENTS: "$(DJBOOTH_LINK_ENTITLEMENTS)", DJBOOTH_LINK_ENTITLEMENTS: "", DJBOOTH_LINK_ENABLED: "NO",
      INFOPLIST_KEY_UIApplicationSceneManifest_Generation: "YES", INFOPLIST_KEY_UILaunchScreen_Generation: "YES" } : { ENABLE_HARDENED_RUNTIME: "YES" }),
  }, { INFOPLIST_FILE: `DJBooth/Info.Debug.${platform}.plist`, DJBOOTH_OFFLINE_COLLECTION: "",
    ...(platform === "iOS" ? { DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym" } : {}) });
  targets.push(object(targetName, `isa = PBXNativeTarget; buildConfigurationList = ${configuration}; buildPhases = (${linkPhase ? `${linkPhase}, ` : ""}${sourcePhase}, ${frameworks}, ${resources}); buildRules = (); dependencies = (); name = ${quote(targetName)}; productName = DJBooth; productReference = ${product}; productType = "com.apple.product-type.application"; packageProductDependencies = (${packageProduct});`));
  const testProduct = object(`${testTargetName}.product`, `isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = ${quote(`${testTargetName}.xctest`)}; sourceTree = BUILT_PRODUCTS_DIR;`);
  products.push(testProduct);
  const testBuildFiles = testSources.map((path) => object(`${testTargetName}.build.${path}`, `isa = PBXBuildFile; fileRef = ${fileReferences.get(path)};`));
  const testSourcePhase = object(`${testTargetName}.sources`, `isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ${array(testBuildFiles)}; runOnlyForDeploymentPostprocessing = 0;`);
  const proxy = object(`${testTargetName}.proxy`, `isa = PBXContainerItemProxy; containerPortal = ${id("project")}; proxyType = 1; remoteGlobalIDString = ${id(targetName)}; remoteInfo = ${quote(targetName)};`);
  const dependency = object(`${testTargetName}.dependency`, `isa = PBXTargetDependency; target = ${id(targetName)}; targetProxy = ${proxy};`);
  const testConfiguration = configurationList(testTargetName, {
    ...common, ...platformSettings, PRODUCT_NAME: "$(TARGET_NAME)", PRODUCT_BUNDLE_IDENTIFIER: `xyz.gakonst.djbooth.uitests.${platform.toLowerCase()}`,
    TEST_TARGET_NAME: targetName, SWIFT_EMIT_LOC_STRINGS: "NO",
  });
  targets.push(object(testTargetName, `isa = PBXNativeTarget; buildConfigurationList = ${testConfiguration}; buildPhases = (${testSourcePhase}); buildRules = (); dependencies = (${dependency}); name = ${quote(testTargetName)}; productName = ${quote(testTargetName)}; productReference = ${testProduct}; productType = "com.apple.product-type.bundle.ui-testing";`));

  const reference = (name, buildable) => `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id(name)}" BuildableName="${buildable}" BlueprintName="${name}" ReferencedContainer="container:DJBooth.xcodeproj"/>`;
  const appReference = reference(targetName, "DJBooth.app");
  const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2660" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${appReference}</BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">${reference(testTargetName, `${testTargetName}.xctest`)}</TestableReference></Testables></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">${appReference}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">${appReference}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`;
  await mkdir(resolve(projectDirectory, "xcshareddata/xcschemes"), { recursive: true });
  await writeFile(resolve(projectDirectory, `xcshareddata/xcschemes/${targetName}.xcscheme`), scheme);
}
const appGroup = object("appGroup", `isa = PBXGroup; name = DJBooth; children = ${array([...fileReferences].filter(([path]) => path.startsWith("DJBooth/")).map(([, reference]) => reference))}; sourceTree = "<group>";`);
const testGroup = object("testGroup", `isa = PBXGroup; name = DJBoothUITests; children = ${array(testSources.map((path) => fileReferences.get(path)))}; sourceTree = "<group>";`);
const productsGroup = object("products", `isa = PBXGroup; name = Products; children = ${array(products)}; sourceTree = "<group>";`);
const mainGroup = object("main", `isa = PBXGroup; children = (${appGroup}, ${testGroup}, ${productsGroup}); sourceTree = "<group>";`);
const projectConfiguration = configurationList("project", { CLANG_ENABLE_OBJC_ARC: "YES", CLANG_WARN_DOCUMENTATION_COMMENTS: "YES", GCC_WARN_UNINITIALIZED_AUTOS: "YES_AGGRESSIVE" });
object("project", `isa = PBXProject; attributes = { LastUpgradeCheck = 2660; BuildIndependentTargetsInParallel = YES; TargetAttributes = { ${["macOS", "iOS"].map((p) => `${id(`DJBoothUITests-${p}`)} = { TestTargetID = ${id(`DJBooth-${p}`)}; };`).join(" ")} }; }; buildConfigurationList = ${projectConfiguration}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = ${mainGroup}; productRefGroup = ${productsGroup}; projectDirPath = ""; projectRoot = ""; targets = ${array(targets)}; packageReferences = (${packageReference});`);
await mkdir(projectDirectory, { recursive: true });
await writeFile(resolve(projectDirectory, "project.pbxproj"), `// !$*UTF8*$!\n// Generated by pnpm --filter @gakonst/djbooth-apple project.\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n${objects.join("\n")}\n}; rootObject = ${id("project")}; }\n`);
console.log(`DJBooth.xcodeproj: ${appSources.length} app sources, ${testSources.length} UI test sources; macOS + iOS.`);
