use std::collections::{BTreeSet, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::path::{Component, Path, PathBuf};
use std::process::Command as ProcessCommand;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const ENV_REKORDBOX_ANALYZER_ROOT: &str = "REKORDBOX_ANALYZER_ROOT";
pub const ENV_REKORDBOX_APP: &str = "REKORDBOX_ANALYZER_APP";
pub const ENV_REKORDBOX_CACHE: &str = "REKORDBOX_ANALYZER_CACHE";
pub const ENV_REKORDBOX_REQUIRE_VENDORED: &str = "REKORDBOX_ANALYZER_REQUIRE_VENDORED";
pub const CACHED_REKORDBOX_NAME: &str = "rekordbox-cached";

const CACHE_MANIFEST_NAME: &str = "source-manifest.json";
const REPO_REKORDBOX_ROOT: &str = "archive/rekordbox/artifacts/rekordbox";
const REPO_RUNTIME_CACHE_SUFFIX: &str = ".rekordbox-analyzer/cache";
const KNOWN_REKORDBOX_6820018_SHA256: &str =
    "19db9964df3751fccd25ec9064b5a3031d7c05aa7c444e5dce3e7d6fc73598bc";
const REKORDBOX_BUNDLE_MANIFEST_NAME: &str = "djtools-rekordbox-bundle.json";
const REKORDBOX_APP_NAME: &str = "rekordbox.app";

const LC_LOAD_DYLIB: u32 = 0x0c;
const LC_LOAD_WEAK_DYLIB: u32 = 0x8000_0018;
const LC_REEXPORT_DYLIB: u32 = 0x8000_001f;
const LC_LOAD_UPWARD_DYLIB: u32 = 0x8000_0023;
const MH_MAGIC_64: u32 = 0xfeed_facf;
const FAT_MAGIC: u32 = 0xcafe_babe;
const FAT_MAGIC_64: u32 = 0xcafe_babf;
const CPU_TYPE_X86_64: u32 = 0x0100_0007;
const CPU_TYPE_ARM64: u32 = 0x0100_000c;

#[derive(Debug, Clone)]
pub struct PreparedRekordboxBackend {
    pub install: RekordboxInstall,
    pub cache: RekordboxCache,
    pub offsets: RekordboxOffsets,
    pub offset_resolution: OffsetResolution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxInstall {
    pub source: String,
    pub repo_root: PathBuf,
    pub app_path: PathBuf,
    pub binary_path: PathBuf,
    pub macos_dir: PathBuf,
    pub frameworks_dir: PathBuf,
    pub bundle_identifier: Option<String>,
    pub version: Option<String>,
    pub build: Option<String>,
    pub binary_sha256: String,
    pub architectures: Vec<String>,
    pub load_dylibs: Vec<String>,
    pub local_dependencies: Vec<RekordboxDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxDependency {
    pub original_load_path: String,
    pub source_path: PathBuf,
    pub cached_name: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxCache {
    pub cache_dir: PathBuf,
    pub cached_binary: PathBuf,
    pub dependencies: Vec<CachedDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedDependency {
    pub original_load_path: String,
    pub source_path: PathBuf,
    pub cached_path: PathBuf,
    pub cached_name: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RekordboxOffsets {
    pub get_analyzer: usize,
    pub start_analyze: usize,
    pub force_key_analysis_patch: usize,
    pub juce_string_default: usize,
    pub juce_string_cstr: usize,
    pub juce_string_dtor: usize,
    pub juce_string_to_raw_utf8: usize,
}

impl RekordboxOffsets {
    fn current_6820018() -> Self {
        Self {
            get_analyzer: 0x1DADF0,
            start_analyze: 0x103DF80,
            force_key_analysis_patch: 0x103E4AC,
            juce_string_default: 0x1BF9B90,
            juce_string_cstr: 0x1BFAE10,
            juce_string_dtor: 0x1BF8290,
            juce_string_to_raw_utf8: 0x1C27F10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OffsetResolution {
    pub source: String,
    pub supported: bool,
    pub binary_sha256: String,
    pub version: Option<String>,
    pub manifest_name: Option<String>,
    pub notes: Vec<String>,
    pub offsets: RekordboxOffsets,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxBackendDiagnostics {
    pub backend_source: String,
    pub strict_vendored: bool,
    pub repo_root: PathBuf,
    pub install: RekordboxInstallDiagnostics,
    pub cache: RekordboxCacheDiagnostics,
    pub offset_resolution: OffsetResolution,
    pub codesign: Vec<CodesignStatus>,
    pub vendoring_investigation: VendoringInvestigation,
    pub extraction_investigation: ExtractionInvestigation,
    pub path_policy: BackendPathPolicyDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxInstallDiagnostics {
    pub source: String,
    pub app_path: PathBuf,
    pub binary_path: PathBuf,
    pub macos_dir: PathBuf,
    pub frameworks_dir: PathBuf,
    pub bundle_identifier: Option<String>,
    pub version: Option<String>,
    pub build: Option<String>,
    pub binary_sha256: String,
    pub architectures: Vec<String>,
    pub load_dylibs: Vec<String>,
    pub local_dependencies: Vec<RekordboxDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxCacheDiagnostics {
    pub cache_dir: PathBuf,
    pub cached_binary: PathBuf,
    pub dependencies: Vec<CachedDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendPathPolicyDiagnostics {
    pub backend_paths: Vec<PathBuf>,
    pub disallowed_path_classes: Vec<String>,
    pub violations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodesignStatus {
    pub path: PathBuf,
    pub valid: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VendoringInvestigation {
    pub implemented: bool,
    pub minimum_current_artifacts: Vec<VendoredArtifactCandidate>,
    pub total_minimum_bytes: u64,
    pub legal_distribution_risk: String,
    pub repo_ergonomics: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VendoredArtifactCandidate {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxBundleReport {
    pub source_app: PathBuf,
    pub output_app: PathBuf,
    pub manifest_path: PathBuf,
    pub created_at: String,
    pub creation_command: Vec<String>,
    pub version: Option<String>,
    pub build: Option<String>,
    pub binary_sha256: String,
    pub artifacts: Vec<RekordboxBundleArtifact>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekordboxBundleArtifact {
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub relative_path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractionInvestigation {
    pub implemented: bool,
    pub conclusion: String,
    pub blocking_dependencies: Vec<String>,
}

pub fn prepare_rekordbox_backend() -> Result<PreparedRekordboxBackend> {
    let install = discover_rekordbox_install()?;
    let (offsets, offset_resolution) = resolve_offsets(&install)?;
    let cache = ensure_rekordbox_cache(&install)?;
    Ok(PreparedRekordboxBackend {
        install,
        cache,
        offsets,
        offset_resolution,
    })
}

pub fn diagnose_rekordbox_backend() -> Result<RekordboxBackendDiagnostics> {
    let prepared = prepare_rekordbox_backend()?;
    verify_install_artifact_hashes(&prepared.install)?;
    let display = DiagnosticPathDisplay::new(prepared.install.repo_root.clone());
    let mut paths = Vec::new();
    paths.push(prepared.cache.cached_binary.clone());
    paths.extend(
        prepared
            .cache
            .dependencies
            .iter()
            .map(|dependency| dependency.cached_path.clone()),
    );
    let codesign = paths
        .iter()
        .map(|path| codesign_status(path))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .map(|status| CodesignStatus {
            path: display.path(&status.path),
            valid: status.valid,
            stdout: display.text(&status.stdout),
            stderr: display.text(&status.stderr),
        })
        .collect::<Vec<_>>();
    let backend_paths = backend_paths_for_policy(&prepared, &display);
    let disallowed_fragments = disallowed_backend_path_fragments();
    let violations = backend_path_policy_violations(&backend_paths, &disallowed_fragments);
    Ok(RekordboxBackendDiagnostics {
        backend_source: prepared.install.source.clone(),
        strict_vendored: strict_vendored_required(),
        repo_root: PathBuf::from("."),
        install: install_diagnostics(&prepared.install, &display),
        cache: cache_diagnostics(&prepared.cache, &display),
        offset_resolution: prepared.offset_resolution.clone(),
        codesign,
        vendoring_investigation: vendoring_investigation(&prepared.install, &display)?,
        extraction_investigation: extraction_investigation(),
        path_policy: BackendPathPolicyDiagnostics {
            backend_paths,
            disallowed_path_classes: disallowed_backend_path_classes(),
            violations,
        },
    })
}

pub fn create_rekordbox_private_bundle(
    output_app: &Path,
    overwrite: bool,
) -> Result<RekordboxBundleReport> {
    let install = discover_rekordbox_bundle_source()?;
    if output_app.exists() {
        if !overwrite {
            bail!(
                "{} already exists; pass --overwrite to replace it",
                output_app.display()
            );
        }
        if output_app.is_dir() {
            std::fs::remove_dir_all(output_app)
                .with_context(|| format!("failed to remove {}", output_app.display()))?;
        } else {
            std::fs::remove_file(output_app)
                .with_context(|| format!("failed to remove {}", output_app.display()))?;
        }
    }

    let info_plist = install.app_path.join("Contents/Info.plist");
    let mut sources = vec![info_plist, install.binary_path.clone()];
    sources.extend(
        install
            .local_dependencies
            .iter()
            .map(|dependency| dependency.source_path.clone()),
    );
    sources.sort();
    sources.dedup();

    let mut artifacts = Vec::new();
    for source in sources {
        artifacts.push(copy_bundle_artifact(
            &install.app_path,
            &source,
            output_app,
        )?);
    }
    let total_bytes = artifacts.iter().map(|artifact| artifact.bytes).sum();
    let manifest_path = output_app
        .join("Contents")
        .join(REKORDBOX_BUNDLE_MANIFEST_NAME);
    let report = RekordboxBundleReport {
        source_app: install.app_path,
        output_app: output_app.to_path_buf(),
        manifest_path: manifest_path.clone(),
        created_at: Utc::now().to_rfc3339(),
        creation_command: std::env::args().collect(),
        version: install.version,
        build: install.build,
        binary_sha256: install.binary_sha256,
        artifacts,
        total_bytes,
    };
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&report)?)
        .with_context(|| format!("failed to write {}", manifest_path.display()))?;
    Ok(report)
}

fn discover_rekordbox_install() -> Result<RekordboxInstall> {
    let repo_root = resolve_repo_root()?;
    let strict_vendored = strict_vendored_required();
    if strict_vendored
        && !repo_vendored_app_candidates(&repo_root)
            .iter()
            .any(|path| path.is_dir())
    {
        bail!(
            "strict vendored mode requires a repo-local Rekordbox bundle under {} (expected {})",
            repo_rekordbox_root(&repo_root).display(),
            default_repo_rekordbox_app(&repo_root).display()
        );
    }
    for (source, app_path) in rekordbox_app_candidates(&repo_root, strict_vendored) {
        if !app_path.is_dir() {
            continue;
        }
        return inspect_rekordbox_app(&source, &repo_root, &app_path)
            .with_context(|| format!("failed to inspect Rekordbox app {}", app_path.display()));
    }
    bail!("no Rekordbox app found; set {ENV_REKORDBOX_APP} to /path/to/rekordbox.app")
}

fn discover_rekordbox_bundle_source() -> Result<RekordboxInstall> {
    let repo_root = resolve_repo_root()?;
    for (source, app_path) in rekordbox_installed_app_candidates() {
        if !app_path.is_dir() {
            continue;
        }
        return inspect_rekordbox_app(&source, &repo_root, &app_path)
            .with_context(|| format!("failed to inspect Rekordbox app {}", app_path.display()));
    }
    bail!(
        "no installed Rekordbox app found for bundle creation; set {ENV_REKORDBOX_APP} to the source .app"
    )
}

fn copy_bundle_artifact(
    source_app: &Path,
    source_path: &Path,
    output_app: &Path,
) -> Result<RekordboxBundleArtifact> {
    let source_path = source_path
        .canonicalize()
        .with_context(|| format!("failed to canonicalize {}", source_path.display()))?;
    let relative_path = source_path
        .strip_prefix(source_app)
        .with_context(|| {
            format!(
                "{} is not inside {}",
                source_path.display(),
                source_app.display()
            )
        })?
        .to_path_buf();
    let destination_path = output_app.join(&relative_path);
    if let Some(parent) = destination_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    std::fs::copy(&source_path, &destination_path).with_context(|| {
        format!(
            "failed to copy {} to {}",
            source_path.display(),
            destination_path.display()
        )
    })?;
    Ok(RekordboxBundleArtifact {
        bytes: source_path.metadata()?.len(),
        sha256: sha256_file(&source_path)?,
        source_path,
        destination_path,
        relative_path,
    })
}

fn rekordbox_app_candidates(repo_root: &Path, strict_vendored: bool) -> Vec<(String, PathBuf)> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    if let Ok(value) = std::env::var(ENV_REKORDBOX_APP) {
        let path = app_path_from_override(Path::new(&value));
        if seen.insert(path.clone()) {
            out.push(("env_override".to_string(), path));
        }
    }
    for path in repo_vendored_app_candidates(repo_root) {
        if seen.insert(path.clone()) {
            out.push(("repo_vendored".to_string(), path));
        }
    }
    if !strict_vendored {
        out.extend(
            rekordbox_installed_app_candidates()
                .into_iter()
                .filter(|(_, path)| seen.insert(path.clone())),
        );
    }
    out
}

fn rekordbox_installed_app_candidates() -> Vec<(String, PathBuf)> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    if let Ok(value) = std::env::var(ENV_REKORDBOX_APP) {
        let path = app_path_from_override(Path::new(&value));
        if seen.insert(path.clone()) {
            out.push(("env_override".to_string(), path));
        }
    }
    for path in [
        PathBuf::from("/Applications/rekordbox 6/rekordbox.app"),
        PathBuf::from("/Applications/rekordbox.app"),
    ] {
        if seen.insert(path.clone()) {
            out.push(("installed_default".to_string(), path));
        }
    }
    out.extend(spotlight_candidates(&mut seen));
    out
}

fn repo_vendored_app_candidates(repo_root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let root = repo_rekordbox_root(repo_root);
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path().join(REKORDBOX_APP_NAME);
            if path.is_dir() {
                out.push(path);
            }
        }
    }
    out.sort();
    out.reverse();
    let default = default_repo_rekordbox_app(repo_root);
    if !out.iter().any(|path| path == &default) {
        out.push(default);
    }
    out
}

fn repo_rekordbox_root(repo_root: &Path) -> PathBuf {
    repo_root.join(REPO_REKORDBOX_ROOT)
}

fn default_repo_rekordbox_app(repo_root: &Path) -> PathBuf {
    repo_rekordbox_root(repo_root)
        .join("6.8.2.0018")
        .join(REKORDBOX_APP_NAME)
}

fn app_path_from_override(path: &Path) -> PathBuf {
    if path.file_name().and_then(|value| value.to_str()) == Some("rekordbox")
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some("MacOS")
    {
        return path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .unwrap_or(path)
            .to_path_buf();
    }
    path.to_path_buf()
}

fn strict_vendored_required() -> bool {
    std::env::var(ENV_REKORDBOX_REQUIRE_VENDORED)
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn resolve_repo_root() -> Result<PathBuf> {
    if let Ok(value) = std::env::var(ENV_REKORDBOX_ANALYZER_ROOT) {
        return PathBuf::from(value)
            .canonicalize()
            .with_context(|| format!("failed to resolve {ENV_REKORDBOX_ANALYZER_ROOT}"));
    }

    let mut starts = Vec::new();
    starts.push(std::env::current_dir().context("failed to read current directory")?);
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        starts.push(parent.to_path_buf());
    }

    for start in starts {
        let mut current = start.as_path();
        loop {
            if current.join("Cargo.toml").is_file() || current.join("AGENTS.md").is_file() {
                return current
                    .canonicalize()
                    .with_context(|| format!("failed to canonicalize {}", current.display()));
            }
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent;
        }
    }

    bail!("failed to resolve analyzer root; set {ENV_REKORDBOX_ANALYZER_ROOT}")
}

fn spotlight_candidates(seen: &mut BTreeSet<PathBuf>) -> Vec<(String, PathBuf)> {
    let output = ProcessCommand::new("mdfind")
        .arg("kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == 'rekordbox.app'")
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| seen.insert(path.clone()))
        .map(|path| ("installed_spotlight".to_string(), path))
        .collect()
}

fn inspect_rekordbox_app(
    source: &str,
    repo_root: &Path,
    app_path: &Path,
) -> Result<RekordboxInstall> {
    let app_path = app_path
        .canonicalize()
        .with_context(|| format!("failed to canonicalize {}", app_path.display()))?;
    let contents_dir = app_path.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    let frameworks_dir = contents_dir.join("Frameworks");
    let binary_path = macos_dir.join("rekordbox");
    if !binary_path.is_file() {
        bail!("missing Rekordbox executable {}", binary_path.display());
    }
    let info = read_info_plist(&contents_dir.join("Info.plist"))?;
    let bundle_manifest = read_sized_bundle_manifest(&app_path)?;
    if let Some(manifest) = &bundle_manifest
        && (manifest.version != info.version || manifest.build != info.build)
    {
        bail!(
            "Rekordbox bundle manifest version/build does not match {}",
            contents_dir.join("Info.plist").display()
        );
    }
    let binary_sha256 = match bundle_manifest
        .as_ref()
        .and_then(|manifest| bundle_artifact_for_path(manifest, &app_path, &binary_path))
    {
        Some(artifact) if artifact.sha256 == manifest_binary_sha(bundle_manifest.as_ref())? => {
            artifact.sha256.clone()
        }
        Some(_) => bail!("Rekordbox bundle manifest binary hash is inconsistent"),
        None => sha256_file(&binary_path)?,
    };
    let architectures = macho_architectures(&binary_path)?;
    let load_dylibs = macho_load_dylibs(&binary_path)?;
    let local_dependencies = local_dependencies(
        &macos_dir,
        &app_path,
        &load_dylibs,
        bundle_manifest.as_ref(),
    )?;
    Ok(RekordboxInstall {
        source: source.to_string(),
        repo_root: repo_root.to_path_buf(),
        app_path,
        binary_path,
        macos_dir,
        frameworks_dir,
        bundle_identifier: info.bundle_identifier,
        version: info.version,
        build: info.build,
        binary_sha256,
        architectures,
        load_dylibs,
        local_dependencies,
    })
}

fn manifest_binary_sha(manifest: Option<&RekordboxBundleReport>) -> Result<&str> {
    manifest
        .map(|manifest| manifest.binary_sha256.as_str())
        .context("missing Rekordbox bundle manifest")
}

fn read_sized_bundle_manifest(app_path: &Path) -> Result<Option<RekordboxBundleReport>> {
    let path = app_path
        .join("Contents")
        .join(REKORDBOX_BUNDLE_MANIFEST_NAME);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let manifest: RekordboxBundleReport = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    let mut total_bytes = 0u64;
    for artifact in &manifest.artifacts {
        if artifact.relative_path.is_absolute()
            || artifact
                .relative_path
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
        {
            bail!(
                "invalid Rekordbox bundle artifact path {}",
                artifact.relative_path.display()
            );
        }
        let artifact_path = app_path.join(&artifact.relative_path);
        let metadata = artifact_path.metadata().with_context(|| {
            format!(
                "missing Rekordbox bundle artifact {}",
                artifact_path.display()
            )
        })?;
        if !metadata.is_file() || metadata.len() != artifact.bytes {
            bail!(
                "Rekordbox bundle artifact size mismatch for {}: expected {}, got {}",
                artifact_path.display(),
                artifact.bytes,
                metadata.len()
            );
        }
        if artifact.sha256.len() != 64
            || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            bail!(
                "invalid Rekordbox bundle artifact hash for {}",
                artifact.relative_path.display()
            );
        }
        total_bytes = total_bytes
            .checked_add(artifact.bytes)
            .context("Rekordbox bundle artifact size overflow")?;
    }
    if total_bytes != manifest.total_bytes {
        bail!(
            "Rekordbox bundle manifest size mismatch: expected {}, got {total_bytes}",
            manifest.total_bytes
        );
    }
    Ok(Some(manifest))
}

fn bundle_artifact_for_path<'a>(
    manifest: &'a RekordboxBundleReport,
    app_path: &Path,
    path: &Path,
) -> Option<&'a RekordboxBundleArtifact> {
    let relative = path.strip_prefix(app_path).ok()?;
    manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.relative_path == relative)
}

#[derive(Debug)]
struct InfoPlist {
    bundle_identifier: Option<String>,
    version: Option<String>,
    build: Option<String>,
}

fn read_info_plist(path: &Path) -> Result<InfoPlist> {
    let value = plist::Value::from_file(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let dict = value
        .as_dictionary()
        .with_context(|| format!("{} is not a plist dictionary", path.display()))?;
    Ok(InfoPlist {
        bundle_identifier: plist_string(dict, "CFBundleIdentifier"),
        version: plist_string(dict, "CFBundleShortVersionString"),
        build: plist_string(dict, "CFBundleVersion"),
    })
}

fn plist_string(dict: &plist::Dictionary, key: &str) -> Option<String> {
    dict.get(key)
        .and_then(plist::Value::as_string)
        .map(ToString::to_string)
}

fn local_dependencies(
    macos_dir: &Path,
    app_path: &Path,
    load_dylibs: &[String],
    bundle_manifest: Option<&RekordboxBundleReport>,
) -> Result<Vec<RekordboxDependency>> {
    let mut out = Vec::new();
    let mut cached_names = BTreeSet::new();
    for load_path in load_dylibs {
        let Some(source_path) = local_dependency_path(macos_dir, app_path, load_path)? else {
            continue;
        };
        let cached_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .with_context(|| format!("dependency has no filename: {}", source_path.display()))?
            .to_string();
        if !cached_names.insert(cached_name.clone()) {
            bail!("duplicate cached dependency name {cached_name}");
        }
        out.push(RekordboxDependency {
            original_load_path: load_path.clone(),
            sha256: match bundle_manifest
                .and_then(|manifest| bundle_artifact_for_path(manifest, app_path, &source_path))
            {
                Some(artifact) => artifact.sha256.clone(),
                None => sha256_file(&source_path)?,
            },
            source_path,
            cached_name,
        });
    }
    out.sort_by(|left, right| left.cached_name.cmp(&right.cached_name));
    Ok(out)
}

fn local_dependency_path(
    macos_dir: &Path,
    app_path: &Path,
    load_path: &str,
) -> Result<Option<PathBuf>> {
    let candidate = if let Some(rest) = load_path.strip_prefix("@executable_path/") {
        Some(macos_dir.join(rest))
    } else if let Some(rest) = load_path.strip_prefix("@loader_path/") {
        Some(macos_dir.join(rest))
    } else if load_path.starts_with(app_path.to_string_lossy().as_ref()) {
        Some(PathBuf::from(load_path))
    } else {
        None
    };
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let path = candidate
        .canonicalize()
        .with_context(|| format!("failed to resolve local Rekordbox dependency {load_path}"))?;
    if !path.starts_with(app_path) {
        return Ok(None);
    }
    Ok(Some(path))
}

fn ensure_rekordbox_cache(install: &RekordboxInstall) -> Result<RekordboxCache> {
    let cache_dir = cache_dir_for_install(install)?;
    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("failed to create {}", cache_dir.display()))?;
    let lock_path = cache_dir.join(".cache.lock");
    let _lock = FileLock::exclusive(&lock_path)?;
    let cached_binary = cache_dir.join(CACHED_REKORDBOX_NAME);
    let dependencies = install
        .local_dependencies
        .iter()
        .map(|dependency| CachedDependency {
            original_load_path: dependency.original_load_path.clone(),
            source_path: dependency.source_path.clone(),
            cached_path: cache_dir.join(&dependency.cached_name),
            cached_name: dependency.cached_name.clone(),
            sha256: dependency.sha256.clone(),
        })
        .collect::<Vec<_>>();

    if cache_is_current(&cached_binary, &dependencies, install)? {
        return Ok(RekordboxCache {
            cache_dir,
            cached_binary,
            dependencies,
        });
    }

    verify_install_artifact_hashes(install)?;
    reset_cache_dir(&cache_dir)?;
    std::fs::copy(&install.binary_path, &cached_binary).with_context(|| {
        format!(
            "failed to copy {} to {}",
            install.binary_path.display(),
            cached_binary.display()
        )
    })?;
    for dependency in &dependencies {
        std::fs::copy(&dependency.source_path, &dependency.cached_path).with_context(|| {
            format!(
                "failed to copy {} to {}",
                dependency.source_path.display(),
                dependency.cached_path.display()
            )
        })?;
    }
    patch_cached_artifacts(&cached_binary, &dependencies)?;
    sign_cached_artifacts(&cached_binary, &dependencies)?;
    write_cache_manifest(&cache_dir, install)?;
    Ok(RekordboxCache {
        cache_dir,
        cached_binary,
        dependencies,
    })
}

fn verify_install_artifact_hashes(install: &RekordboxInstall) -> Result<()> {
    let binary_sha256 = sha256_file(&install.binary_path)?;
    if binary_sha256 != install.binary_sha256 {
        bail!(
            "Rekordbox executable hash mismatch for {}: expected {}, got {binary_sha256}",
            install.binary_path.display(),
            install.binary_sha256
        );
    }
    for dependency in &install.local_dependencies {
        let sha256 = sha256_file(&dependency.source_path)?;
        if sha256 != dependency.sha256 {
            bail!(
                "Rekordbox dependency hash mismatch for {}: expected {}, got {sha256}",
                dependency.source_path.display(),
                dependency.sha256
            );
        }
    }
    Ok(())
}

fn cache_is_current(
    cached_binary: &Path,
    dependencies: &[CachedDependency],
    install: &RekordboxInstall,
) -> Result<bool> {
    if !cached_binary.is_file() {
        return Ok(false);
    }
    for dependency in dependencies {
        if !dependency.cached_path.is_file() {
            return Ok(false);
        }
    }
    let manifest = match read_cache_manifest(&cache_dir_for_install(install)?) {
        Ok(Some(manifest)) => manifest,
        Ok(None) | Err(_) => return Ok(false),
    };
    Ok(manifest == cache_manifest_for_install(install))
}

fn reset_cache_dir(cache_dir: &Path) -> Result<()> {
    for entry in std::fs::read_dir(cache_dir)
        .with_context(|| format!("failed to read {}", cache_dir.display()))?
    {
        let path = entry?.path();
        if path.file_name().and_then(|value| value.to_str()) == Some(".cache.lock") {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        }
        .with_context(|| format!("failed to remove {}", path.display()))?;
    }
    Ok(())
}

fn patch_cached_artifacts(cached_binary: &Path, dependencies: &[CachedDependency]) -> Result<()> {
    let mut change_args = Vec::new();
    for dependency in dependencies {
        change_args.push("-change".to_string());
        change_args.push(dependency.original_load_path.clone());
        change_args.push(format!("@loader_path/{}", dependency.cached_name));
    }
    if !change_args.is_empty() {
        change_args.push(path_str(cached_binary)?);
        run_command("install_name_tool", &change_args)?;
    }

    let by_original = dependencies
        .iter()
        .map(|dependency| {
            (
                dependency.original_load_path.as_str(),
                format!("@loader_path/{}", dependency.cached_name),
            )
        })
        .collect::<HashMap<_, _>>();
    for dependency in dependencies {
        run_command(
            "install_name_tool",
            &[
                "-id".to_string(),
                format!("@loader_path/{}", dependency.cached_name),
                path_str(&dependency.cached_path)?,
            ],
        )?;
        let load_dylibs = macho_load_dylibs(&dependency.cached_path)?;
        let mut dep_change_args = Vec::new();
        for load_path in &load_dylibs {
            if let Some(replacement) = by_original.get(load_path.as_str()) {
                dep_change_args.push("-change".to_string());
                dep_change_args.push(load_path.clone());
                dep_change_args.push(replacement.clone());
            }
        }
        if !dep_change_args.is_empty() {
            dep_change_args.push(path_str(&dependency.cached_path)?);
            run_command("install_name_tool", &dep_change_args)?;
        }
    }
    Ok(())
}

fn sign_cached_artifacts(cached_binary: &Path, dependencies: &[CachedDependency]) -> Result<()> {
    for dependency in dependencies {
        run_command(
            "codesign",
            &[
                "--force".to_string(),
                "--sign".to_string(),
                "-".to_string(),
                path_str(&dependency.cached_path)?,
            ],
        )?;
    }
    run_command(
        "codesign",
        &[
            "--force".to_string(),
            "--sign".to_string(),
            "-".to_string(),
            path_str(cached_binary)?,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CacheManifest {
    schema_version: u32,
    version: Option<String>,
    build: Option<String>,
    binary_sha256: String,
    dependencies: Vec<CacheManifestDependency>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CacheManifestDependency {
    original_load_path: String,
    cached_name: String,
    sha256: String,
}

fn cache_manifest_for_install(install: &RekordboxInstall) -> CacheManifest {
    CacheManifest {
        schema_version: 1,
        version: install.version.clone(),
        build: install.build.clone(),
        binary_sha256: install.binary_sha256.clone(),
        dependencies: install
            .local_dependencies
            .iter()
            .map(|dependency| CacheManifestDependency {
                original_load_path: dependency.original_load_path.clone(),
                cached_name: dependency.cached_name.clone(),
                sha256: dependency.sha256.clone(),
            })
            .collect(),
    }
}

fn write_cache_manifest(cache_dir: &Path, install: &RekordboxInstall) -> Result<()> {
    let path = cache_dir.join(CACHE_MANIFEST_NAME);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&cache_manifest_for_install(install))?,
    )
    .with_context(|| format!("failed to write {}", path.display()))
}

fn read_cache_manifest(cache_dir: &Path) -> Result<Option<CacheManifest>> {
    let path = cache_dir.join(CACHE_MANIFEST_NAME);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let manifest = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(Some(manifest))
}

fn cache_dir_for_install(install: &RekordboxInstall) -> Result<PathBuf> {
    let base = if let Ok(value) = std::env::var(ENV_REKORDBOX_CACHE) {
        PathBuf::from(value)
    } else {
        install.repo_root.join(REPO_RUNTIME_CACHE_SUFFIX)
    };
    Ok(base.join(format!(
        "{}-{}",
        sanitize_slug(install.version.as_deref().unwrap_or("unknown")),
        &install.binary_sha256[..12]
    )))
}

fn sanitize_slug(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn resolve_offsets(install: &RekordboxInstall) -> Result<(RekordboxOffsets, OffsetResolution)> {
    if install.binary_sha256 == KNOWN_REKORDBOX_6820018_SHA256 {
        let offsets = RekordboxOffsets::current_6820018();
        validate_offset_signatures_file(&install.binary_path, offsets)?;
        return Ok((
            offsets,
            OffsetResolution {
                source: "manifest".to_string(),
                supported: true,
                binary_sha256: install.binary_sha256.clone(),
                version: install.version.clone(),
                manifest_name: Some("rekordbox-6.8.2.0018-sha256-19db9964".to_string()),
                notes: vec!["known binary hash; offsets validated by byte signatures".to_string()],
                offsets,
            },
        ));
    }

    let binary = std::fs::read(&install.binary_path)
        .with_context(|| format!("failed to read {}", install.binary_path.display()))?;
    let offsets = scan_offset_signatures(&binary).with_context(|| {
        format!(
            "unsupported Rekordbox binary {} {}",
            install.version.as_deref().unwrap_or("unknown-version"),
            install.binary_sha256
        )
    })?;
    Ok((
        offsets,
        OffsetResolution {
            source: "pattern_scan".to_string(),
            supported: true,
            binary_sha256: install.binary_sha256.clone(),
            version: install.version.clone(),
            manifest_name: None,
            notes: vec![
                "unknown binary hash; all current byte signatures resolved uniquely".to_string(),
                "treat this as provisional until a smoke test confirms analyzer output".to_string(),
            ],
            offsets,
        },
    ))
}

fn validate_offset_signatures_file(path: &Path, offsets: RekordboxOffsets) -> Result<()> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    for signature in offset_signatures() {
        let offset = (signature.offset_from)(offsets);
        file.seek(SeekFrom::Start(offset as u64))?;
        let mut actual = vec![0u8; signature.bytes.len()];
        file.read_exact(&mut actual)?;
        if actual != signature.bytes {
            bail!("offset signature mismatch for {}", signature.name);
        }
    }
    Ok(())
}

fn scan_offset_signatures(binary: &[u8]) -> Result<RekordboxOffsets> {
    let mut offsets = RekordboxOffsets {
        get_analyzer: 0,
        start_analyze: 0,
        force_key_analysis_patch: 0,
        juce_string_default: 0,
        juce_string_cstr: 0,
        juce_string_dtor: 0,
        juce_string_to_raw_utf8: 0,
    };
    for signature in offset_signatures() {
        let offset = find_unique_signature(binary, signature.bytes)
            .with_context(|| format!("failed to resolve {}", signature.name))?;
        (signature.write_offset)(&mut offsets, offset);
    }
    Ok(offsets)
}

struct OffsetSignature {
    name: &'static str,
    bytes: &'static [u8],
    offset_from: fn(RekordboxOffsets) -> usize,
    write_offset: fn(&mut RekordboxOffsets, usize),
}

fn offset_signatures() -> Vec<OffsetSignature> {
    vec![
        OffsetSignature {
            name: "CAnalyzerIF::getInstance",
            bytes: &[
                0x55, 0x48, 0x89, 0xe5, 0x41, 0x57, 0x41, 0x56, 0x53, 0x50, 0x48, 0x8d, 0x1d, 0x27,
                0x91, 0x05, 0x04, 0x48, 0x8b, 0x03,
            ],
            offset_from: |offsets| offsets.get_analyzer,
            write_offset: |offsets, value| offsets.get_analyzer = value,
        },
        OffsetSignature {
            name: "CAnalyzerIF::startAnalyze",
            bytes: &[
                0x55, 0x48, 0x89, 0xe5, 0x41, 0x57, 0x41, 0x56, 0x41, 0x55, 0x41, 0x54, 0x53, 0x48,
                0x81, 0xec, 0x98, 0x00, 0x00, 0x00,
            ],
            offset_from: |offsets| offsets.start_analyze,
            write_offset: |offsets, value| offsets.start_analyze = value,
        },
        OffsetSignature {
            name: "force key analysis patch site",
            bytes: &[
                0x8a, 0x45, 0xd7, 0x88, 0x45, 0xab, 0x66, 0xc7, 0x45, 0xac, 0x00, 0x00, 0x8a, 0x45,
                0x20,
            ],
            offset_from: |offsets| offsets.force_key_analysis_patch,
            write_offset: |offsets, value| offsets.force_key_analysis_patch = value,
        },
        OffsetSignature {
            name: "juce::String default ctor",
            bytes: &[
                0x55, 0x48, 0x89, 0xe5, 0x48, 0x8d, 0x05, 0xd5, 0x44, 0x05, 0x02, 0x48, 0x89, 0x07,
                0x5d, 0xc3,
            ],
            offset_from: |offsets| offsets.juce_string_default,
            write_offset: |offsets, value| offsets.juce_string_default = value,
        },
        OffsetSignature {
            name: "juce::String cstr ctor",
            bytes: &[
                0x55, 0x48, 0x89, 0xe5, 0x41, 0x57, 0x41, 0x56, 0x41, 0x54, 0x53, 0x49, 0x89, 0xfe,
                0x48, 0x8d, 0x05, 0x4b, 0x32, 0x05, 0x02,
            ],
            offset_from: |offsets| offsets.juce_string_cstr,
            write_offset: |offsets, value| offsets.juce_string_cstr = value,
        },
        OffsetSignature {
            name: "juce::String dtor",
            bytes: &[
                0x55, 0x48, 0x89, 0xe5, 0x48, 0x8b, 0x3f, 0x48, 0x83, 0xc7, 0xf0, 0x48, 0x8d, 0x05,
                0xbe, 0x5d, 0x05, 0x02,
            ],
            offset_from: |offsets| offsets.juce_string_dtor,
            write_offset: |offsets, value| offsets.juce_string_dtor = value,
        },
        OffsetSignature {
            name: "juce::String::toRawUTF8",
            bytes: &[0x55, 0x48, 0x89, 0xe5, 0x48, 0x8b, 0x07, 0x5d, 0xc3],
            offset_from: |offsets| offsets.juce_string_to_raw_utf8,
            write_offset: |offsets, value| offsets.juce_string_to_raw_utf8 = value,
        },
    ]
}

fn find_unique_signature(binary: &[u8], pattern: &[u8]) -> Result<usize> {
    let mut matches = binary
        .windows(pattern.len())
        .enumerate()
        .filter_map(|(index, window)| (window == pattern).then_some(index));
    let Some(first) = matches.next() else {
        bail!("signature not found");
    };
    if let Some(second) = matches.next() {
        bail!("signature is not unique: {first:#x}, {second:#x}");
    }
    Ok(first)
}

fn macho_architectures(path: &Path) -> Result<Vec<String>> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)?;
    let magic_le = u32::from_le_bytes(magic);
    let magic_be = u32::from_be_bytes(magic);
    if magic_le == MH_MAGIC_64 {
        file.seek(SeekFrom::Start(4))?;
        let cputype = read_u32_le(&mut file)?;
        return Ok(vec![cpu_type_name(cputype).to_string()]);
    }
    if magic_be == FAT_MAGIC || magic_be == FAT_MAGIC_64 {
        let nfat_arch = read_u32_be(&mut file)?;
        let arch_size = if magic_be == FAT_MAGIC_64 { 32 } else { 20 };
        let mut out = Vec::new();
        for _ in 0..nfat_arch {
            let cputype = read_u32_be(&mut file)?;
            file.seek(SeekFrom::Current((arch_size - 4) as i64))?;
            out.push(cpu_type_name(cputype).to_string());
        }
        return Ok(out);
    }
    bail!("unsupported Mach-O magic in {}", path.display())
}

fn macho_load_dylibs(path: &Path) -> Result<Vec<String>> {
    let data = std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    let slice = macho_preferred_slice(&data)?;
    parse_macho_load_dylibs(slice)
}

fn macho_preferred_slice(data: &[u8]) -> Result<&[u8]> {
    let magic = be32_slice(data, 0).context("missing Mach-O magic")?;
    if le32_slice(data, 0) == Some(MH_MAGIC_64) {
        return Ok(data);
    }
    if magic != FAT_MAGIC && magic != FAT_MAGIC_64 {
        bail!("unsupported Mach-O magic");
    }
    let nfat_arch = be32_slice(data, 4).context("missing fat arch count")? as usize;
    let arch_size = if magic == FAT_MAGIC_64 { 32 } else { 20 };
    let mut fallback = None;
    for index in 0..nfat_arch {
        let offset = 8 + (index * arch_size);
        let cputype = be32_slice(data, offset).context("missing fat cputype")?;
        let arch_offset = if magic == FAT_MAGIC_64 {
            be64_slice(data, offset + 8).context("missing fat64 offset")? as usize
        } else {
            be32_slice(data, offset + 8).context("missing fat offset")? as usize
        };
        let arch_size = if magic == FAT_MAGIC_64 {
            be64_slice(data, offset + 16).context("missing fat64 size")? as usize
        } else {
            be32_slice(data, offset + 12).context("missing fat size")? as usize
        };
        if fallback.is_none() {
            fallback = Some((arch_offset, arch_size));
        }
        if cputype == CPU_TYPE_X86_64 {
            return data
                .get(arch_offset..arch_offset + arch_size)
                .context("fat x86_64 slice out of range");
        }
    }
    let (offset, size) = fallback.context("fat Mach-O has no slices")?;
    data.get(offset..offset + size)
        .context("fat fallback slice out of range")
}

fn parse_macho_load_dylibs(data: &[u8]) -> Result<Vec<String>> {
    if le32_slice(data, 0) != Some(MH_MAGIC_64) {
        bail!("expected 64-bit little-endian Mach-O");
    }
    let ncmds = le32_slice(data, 16).context("missing ncmds")? as usize;
    let sizeofcmds = le32_slice(data, 20).context("missing sizeofcmds")? as usize;
    let mut offset = 32usize;
    let command_end = offset + sizeofcmds;
    let mut out = Vec::new();
    for _ in 0..ncmds {
        if offset + 8 > data.len() || offset >= command_end {
            bail!("invalid Mach-O load command table");
        }
        let cmd = le32_slice(data, offset).context("missing load command")?;
        let cmdsize = le32_slice(data, offset + 4).context("missing load command size")? as usize;
        if cmdsize < 8 || offset + cmdsize > data.len() {
            bail!("invalid Mach-O load command size");
        }
        if matches!(
            cmd,
            LC_LOAD_DYLIB | LC_LOAD_WEAK_DYLIB | LC_REEXPORT_DYLIB | LC_LOAD_UPWARD_DYLIB
        ) {
            let name_offset =
                le32_slice(data, offset + 8).context("missing dylib name offset")? as usize;
            let start = offset + name_offset;
            if start >= offset + cmdsize {
                bail!("invalid dylib name offset");
            }
            let relative_end = data[start..offset + cmdsize]
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(offset + cmdsize - start);
            let name = std::str::from_utf8(&data[start..start + relative_end])
                .context("dylib name is not utf8")?
                .to_string();
            out.push(name);
        }
        offset += cmdsize;
    }
    Ok(out)
}

fn cpu_type_name(value: u32) -> &'static str {
    match value {
        CPU_TYPE_X86_64 => "x86_64",
        CPU_TYPE_ARM64 => "arm64",
        _ => "unknown",
    }
}

fn read_u32_le(file: &mut File) -> Result<u32> {
    let mut bytes = [0u8; 4];
    file.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u32_be(file: &mut File) -> Result<u32> {
    let mut bytes = [0u8; 4];
    file.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

fn le32_slice(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn be32_slice(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn be64_slice(data: &[u8], offset: usize) -> Option<u64> {
    data.get(offset..offset + 8).map(|bytes| {
        u64::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ])
    })
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[derive(Debug, Clone)]
struct DiagnosticPathDisplay {
    repo_root: PathBuf,
}

impl DiagnosticPathDisplay {
    fn new(repo_root: PathBuf) -> Self {
        Self { repo_root }
    }

    fn path(&self, path: &Path) -> PathBuf {
        let path = path
            .canonicalize()
            .unwrap_or_else(|_| absolutize(path).unwrap_or_else(|| path.to_path_buf()));
        path.strip_prefix(&self.repo_root)
            .map(Path::to_path_buf)
            .unwrap_or(path)
    }

    fn text(&self, value: &str) -> String {
        value.replace(self.repo_root.to_string_lossy().as_ref(), ".")
    }
}

fn absolutize(path: &Path) -> Option<PathBuf> {
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    std::env::current_dir().ok().map(|cwd| cwd.join(path))
}

fn install_diagnostics(
    install: &RekordboxInstall,
    display: &DiagnosticPathDisplay,
) -> RekordboxInstallDiagnostics {
    RekordboxInstallDiagnostics {
        source: install.source.clone(),
        app_path: display.path(&install.app_path),
        binary_path: display.path(&install.binary_path),
        macos_dir: display.path(&install.macos_dir),
        frameworks_dir: display.path(&install.frameworks_dir),
        bundle_identifier: install.bundle_identifier.clone(),
        version: install.version.clone(),
        build: install.build.clone(),
        binary_sha256: install.binary_sha256.clone(),
        architectures: install.architectures.clone(),
        load_dylibs: install.load_dylibs.clone(),
        local_dependencies: install
            .local_dependencies
            .iter()
            .map(|dependency| RekordboxDependency {
                original_load_path: dependency.original_load_path.clone(),
                source_path: display.path(&dependency.source_path),
                cached_name: dependency.cached_name.clone(),
                sha256: dependency.sha256.clone(),
            })
            .collect(),
    }
}

fn cache_diagnostics(
    cache: &RekordboxCache,
    display: &DiagnosticPathDisplay,
) -> RekordboxCacheDiagnostics {
    RekordboxCacheDiagnostics {
        cache_dir: display.path(&cache.cache_dir),
        cached_binary: display.path(&cache.cached_binary),
        dependencies: cache
            .dependencies
            .iter()
            .map(|dependency| CachedDependency {
                original_load_path: dependency.original_load_path.clone(),
                source_path: display.path(&dependency.source_path),
                cached_path: display.path(&dependency.cached_path),
                cached_name: dependency.cached_name.clone(),
                sha256: dependency.sha256.clone(),
            })
            .collect(),
    }
}

fn backend_paths_for_policy(
    prepared: &PreparedRekordboxBackend,
    display: &DiagnosticPathDisplay,
) -> Vec<PathBuf> {
    let mut paths = vec![
        display.path(&prepared.install.app_path),
        display.path(&prepared.install.binary_path),
        display.path(&prepared.install.macos_dir),
        display.path(&prepared.install.frameworks_dir),
        display.path(&prepared.cache.cache_dir),
        display.path(&prepared.cache.cached_binary),
    ];
    for dependency in &prepared.install.local_dependencies {
        paths.push(display.path(&dependency.source_path));
    }
    for dependency in &prepared.cache.dependencies {
        paths.push(display.path(&dependency.cached_path));
    }
    paths.sort();
    paths.dedup();
    paths
}

fn disallowed_backend_path_fragments() -> Vec<String> {
    vec![
        "/Users/".to_string(),
        "~/Library/Caches".to_string(),
        "/tmp/djskills".to_string(),
    ]
}

fn disallowed_backend_path_classes() -> Vec<String> {
    vec![
        "absolute user-home paths".to_string(),
        "home Library cache paths".to_string(),
        "djskills tmp proof paths".to_string(),
    ]
}

fn backend_path_policy_violations(paths: &[PathBuf], fragments: &[String]) -> Vec<String> {
    let mut violations = Vec::new();
    for path in paths {
        let rendered = path.display().to_string();
        for fragment in fragments {
            if rendered.contains(fragment) {
                violations.push(format!("{rendered} contains {fragment}"));
            }
        }
    }
    violations
}

fn codesign_status(path: &Path) -> Result<CodesignStatus> {
    let output = ProcessCommand::new("codesign")
        .arg("--verify")
        .arg("--verbose")
        .arg(path)
        .output()
        .with_context(|| format!("failed to launch codesign for {}", path.display()))?;
    Ok(CodesignStatus {
        path: path.to_path_buf(),
        valid: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn vendoring_investigation(
    install: &RekordboxInstall,
    display: &DiagnosticPathDisplay,
) -> Result<VendoringInvestigation> {
    let mut artifacts = Vec::new();
    artifacts.push(VendoredArtifactCandidate {
        bytes: install.binary_path.metadata()?.len(),
        sha256: install.binary_sha256.clone(),
        path: display.path(&install.binary_path),
    });
    for dependency in &install.local_dependencies {
        artifacts.push(VendoredArtifactCandidate {
            bytes: dependency.source_path.metadata()?.len(),
            sha256: dependency.sha256.clone(),
            path: display.path(&dependency.source_path),
        });
    }
    let total_minimum_bytes = artifacts.iter().map(|artifact| artifact.bytes).sum();
    Ok(VendoringInvestigation {
        implemented: true,
        total_minimum_bytes,
        minimum_current_artifacts: artifacts,
        legal_distribution_risk: "high: the current Rekordbox EULA restricts copying and reverse engineering except where applicable law permits; do not publish vendored AlphaTheta binaries without counsel/permission".to_string(),
        repo_ergonomics: "supported as a repo-local private app-layout bundle under private/rekordbox; current minimum binary payload is about 102 MiB and is provenance-tracked by the bundle manifest".to_string(),
    })
}

fn extraction_investigation() -> ExtractionInvestigation {
    ExtractionInvestigation {
        implemented: false,
        conclusion: "not practical as inline Rust/assembly from current evidence; startAnalyze immediately depends on CAnalyzerIF singleton state, JUCE String/CriticalSection/Thread/OwnedArray types, analyzer worker classes, ANLZ writers, codecs, and callbacks".to_string(),
        blocking_dependencies: vec![
            "CAnalyzerIF singleton construction and mutable global analyzer state".to_string(),
            "JUCE ABI objects passed across the call boundary".to_string(),
            "Beat/key analyzer worker classes and thread lifecycle".to_string(),
            "ANLZ DAT/EXT/2EX serializer graph".to_string(),
            "Bundled codec/cloud/audio helper dylibs plus macOS frameworks".to_string(),
        ],
    }
}

fn run_command(program: &str, args: &[String]) -> Result<()> {
    let output = ProcessCommand::new(program)
        .args(args)
        .output()
        .with_context(|| format!("failed to launch {program}"))?;
    if output.status.success() {
        return Ok(());
    }
    bail!(
        "command failed: {} {} stdout={} stderr={}",
        program,
        args.join(" "),
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
}

fn path_str(path: &Path) -> Result<String> {
    path.to_str()
        .map(ToString::to_string)
        .with_context(|| format!("path is not utf8: {}", path.display()))
}

struct FileLock {
    file: File,
}

impl FileLock {
    fn exclusive(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result != 0 {
            bail!("failed to lock {}", path.display());
        }
        Ok(Self { file })
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_binary_path_maps_back_to_app() {
        let app = app_path_from_override(Path::new(
            "/Applications/rekordbox 6/rekordbox.app/Contents/MacOS/rekordbox",
        ));
        assert_eq!(
            app,
            PathBuf::from("/Applications/rekordbox 6/rekordbox.app")
        );
    }

    #[test]
    fn cache_slug_preserves_versions() {
        assert_eq!(sanitize_slug("6.8.2.0018"), "6.8.2.0018");
        assert_eq!(sanitize_slug("weird version/value"), "weird-version-value");
    }

    #[test]
    fn diagnostic_paths_are_repo_relative() {
        let display = DiagnosticPathDisplay::new(PathBuf::from("/Users/example/repo"));
        let rendered = display.path(Path::new(
            "/Users/example/repo/private/rekordbox/6.8.2.0018/rekordbox.app",
        ));
        assert_eq!(
            rendered,
            PathBuf::from("private/rekordbox/6.8.2.0018/rekordbox.app")
        );
    }

    #[test]
    fn backend_path_policy_flags_user_cache_tmp_fragments() {
        let fragments = disallowed_backend_path_fragments();
        let paths = vec![
            PathBuf::from("/Users/example/Library/Caches/djtools"),
            PathBuf::from("/tmp/djskills-proof/cache"),
            PathBuf::from("private/rekordbox/6.8.2.0018/rekordbox.app"),
        ];
        let violations = backend_path_policy_violations(&paths, &fragments);
        assert_eq!(violations.len(), 2);
    }
}
