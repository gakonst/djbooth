mod gadget;

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use gadget::{GadgetFs, SystemGadgetFs};

use crate::gadget::GadgetController;

const ACTIVE_SCHEMA_VERSION: u8 = 1;
const ACTIVE_FILE_NAME: &str = "active.json";
const GENERATIONS_DIRECTORY: &str = "generations";
const LOCK_FILE_NAME: &str = ".lifecycle.lock";

#[derive(Clone, Debug)]
pub struct AppliancePaths {
    state_dir: PathBuf,
    configfs_root: PathBuf,
    udc_root: PathBuf,
    gadget_name: String,
}

impl AppliancePaths {
    pub fn new(
        state_dir: PathBuf,
        configfs_root: PathBuf,
        udc_root: PathBuf,
        gadget_name: String,
    ) -> Result<Self> {
        validate_gadget_name(&gadget_name)?;
        Ok(Self {
            state_dir,
            configfs_root,
            udc_root,
            gadget_name,
        })
    }

    fn active_path(&self) -> PathBuf {
        self.state_dir.join(ACTIVE_FILE_NAME)
    }

    fn generations_dir(&self) -> PathBuf {
        self.state_dir.join(GENERATIONS_DIRECTORY)
    }
}

#[derive(Clone, Debug)]
pub struct UsbIdentity {
    serial: String,
    manufacturer: String,
    product: String,
}

impl UsbIdentity {
    pub fn new(serial: Option<String>, manufacturer: String, product: String) -> Result<Self> {
        let serial = serial.unwrap_or_else(default_serial);
        for (name, value) in [
            ("serial", serial.as_str()),
            ("manufacturer", manufacturer.as_str()),
            ("product", product.as_str()),
        ] {
            validate_usb_string(name, value)?;
        }
        Ok(Self {
            serial,
            manufacturer,
            product,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveImage {
    pub schema_version: u8,
    pub generation: String,
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
    pub published_at_unix_ms: u64,
    pub has_boot_signature: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CdjUsbStatus {
    pub schema_version: u8,
    pub gadget_name: String,
    pub configured: bool,
    pub attached: bool,
    pub safe_to_publish: bool,
    pub udc: Option<String>,
    pub host_state: Option<String>,
    pub backing_file: Option<PathBuf>,
    pub read_only: Option<bool>,
    pub active_image: Option<ActiveImage>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub name: String,
    pub ok: bool,
    pub required: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResult {
    pub ok: bool,
    pub checks: Vec<DoctorCheck>,
    pub status: CdjUsbStatus,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub published: bool,
    pub reused: bool,
    pub active_image: ActiveImage,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub attached: bool,
    pub status: CdjUsbStatus,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetachResult {
    pub detached: bool,
    pub status: CdjUsbStatus,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub publish: PublishResult,
    pub attach: AttachResult,
}

pub struct Appliance<B: GadgetFs> {
    paths: AppliancePaths,
    gadget_fs: B,
}

impl<B: GadgetFs> Appliance<B> {
    pub fn new(paths: AppliancePaths, gadget_fs: B) -> Self {
        Self { paths, gadget_fs }
    }

    pub fn status(&self) -> Result<CdjUsbStatus> {
        let active_image = self.read_active_image()?;
        let controller = self.controller();
        let gadget = controller.status()?;
        Ok(CdjUsbStatus {
            schema_version: ACTIVE_SCHEMA_VERSION,
            gadget_name: self.paths.gadget_name.clone(),
            configured: gadget.configured,
            attached: gadget.attached,
            safe_to_publish: !gadget.configured,
            udc: gadget.udc,
            host_state: gadget.host_state,
            backing_file: gadget.backing_file,
            read_only: gadget.read_only,
            active_image,
        })
    }

    pub fn doctor(&self, candidate: Option<&Path>) -> Result<DoctorResult> {
        let status = self.status()?;
        let mut checks = Vec::new();
        checks.push(DoctorCheck {
            name: "platform".to_string(),
            ok: cfg!(target_os = "linux"),
            required: true,
            detail: if cfg!(target_os = "linux") {
                "Linux supports configfs USB gadgets".to_string()
            } else {
                format!(
                    "{} can inspect images but cannot attach a Linux USB gadget",
                    std::env::consts::OS
                )
            },
        });

        let configfs_ok = self.gadget_fs.exists(&self.paths.configfs_root);
        checks.push(DoctorCheck {
            name: "configfs".to_string(),
            ok: configfs_ok,
            required: true,
            detail: if configfs_ok {
                self.paths.configfs_root.display().to_string()
            } else {
                format!(
                    "{} is missing; mount configfs and load libcomposite",
                    self.paths.configfs_root.display()
                )
            },
        });

        let udcs = if self.gadget_fs.exists(&self.paths.udc_root) {
            self.gadget_fs
                .list_dir_names(&self.paths.udc_root)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        checks.push(DoctorCheck {
            name: "usb-device-controller".to_string(),
            ok: !udcs.is_empty(),
            required: true,
            detail: if udcs.is_empty() {
                format!(
                    "no UDC is exposed under {}; confirm this board and port support USB device mode",
                    self.paths.udc_root.display()
                )
            } else {
                udcs.join(", ")
            },
        });

        let selected_image = match candidate {
            Some(path) => Some(path),
            None => status
                .active_image
                .as_ref()
                .map(|active| active.path.as_path()),
        };
        let (image_ok, image_detail) = match selected_image {
            Some(path) => match validate_image(path) {
                Ok(image) => (
                    true,
                    format!(
                        "{} bytes, 512-byte aligned, boot signature={}",
                        image.bytes, image.has_boot_signature
                    ),
                ),
                Err(error) => (false, format!("{error:#}")),
            },
            None => (false, "no candidate or active disk image".to_string()),
        };
        checks.push(DoctorCheck {
            name: "disk-image".to_string(),
            ok: image_ok,
            required: true,
            detail: image_detail,
        });

        let read_only_ok = status.read_only.unwrap_or(true);
        checks.push(DoctorCheck {
            name: "read-only-lun".to_string(),
            ok: read_only_ok,
            required: true,
            detail: match status.read_only {
                Some(true) => "configured mass-storage LUN is read-only".to_string(),
                Some(false) => "configured mass-storage LUN is writable".to_string(),
                None => "gadget is not configured".to_string(),
            },
        });

        let backing_matches = match (&status.backing_file, &status.active_image) {
            (Some(backing), Some(active)) => canonical_or_original(backing) == active.path,
            (None, _) => true,
            (Some(_), None) => false,
        };
        checks.push(DoctorCheck {
            name: "active-generation".to_string(),
            ok: backing_matches,
            required: true,
            detail: if backing_matches {
                "kernel backing file matches the active generation".to_string()
            } else {
                "kernel backing file differs from active.json; detach before publishing".to_string()
            },
        });

        Ok(DoctorResult {
            ok: checks.iter().all(|check| !check.required || check.ok),
            checks,
            status,
        })
    }

    pub fn publish(&self, source: &Path) -> Result<PublishResult> {
        let _lock = self.lock_lifecycle()?;
        self.publish_unlocked(source)
    }

    pub fn attach(&self, udc: Option<&str>, identity: &UsbIdentity) -> Result<AttachResult> {
        let _lock = self.lock_lifecycle()?;
        self.attach_unlocked(udc, identity)
    }

    pub fn detach(&self, confirm_host_ejected: bool) -> Result<DetachResult> {
        let _lock = self.lock_lifecycle()?;
        let before = self.status()?;
        if !before.configured {
            return Ok(DetachResult {
                detached: false,
                status: before,
            });
        }
        self.controller().detach(confirm_host_ejected)?;
        Ok(DetachResult {
            detached: true,
            status: self.status()?,
        })
    }

    pub fn run(
        &self,
        source: &Path,
        udc: Option<&str>,
        identity: &UsbIdentity,
    ) -> Result<RunResult> {
        let _lock = self.lock_lifecycle()?;
        let publish = self.publish_unlocked(source)?;
        let attach = self.attach_unlocked(udc, identity)?;
        Ok(RunResult { publish, attach })
    }

    fn publish_unlocked(&self, source: &Path) -> Result<PublishResult> {
        let status = self.status()?;
        if !status.safe_to_publish {
            bail!(
                "USB gadget '{}' is configured; detach it before publishing another image",
                self.paths.gadget_name
            );
        }
        let source = source
            .canonicalize()
            .with_context(|| format!("failed to resolve disk image '{}'", source.display()))?;
        let validation = validate_image(&source)?;
        let sha256 = sha256_file(&source)?;
        let generation = sha256.clone();

        fs::create_dir_all(self.paths.generations_dir()).with_context(|| {
            format!(
                "failed to create generation directory '{}'",
                self.paths.generations_dir().display()
            )
        })?;
        let destination = self
            .paths
            .generations_dir()
            .join(format!("{generation}.img"));
        let reused = destination.exists();
        if reused {
            let existing = validate_image(&destination)?;
            let existing_hash = sha256_file(&destination)?;
            if existing.bytes != validation.bytes || existing_hash != sha256 {
                bail!(
                    "immutable generation '{}' does not match its content-addressed name",
                    destination.display()
                );
            }
        } else {
            copy_generation(&source, &destination, &sha256, validation.bytes)?;
        }
        let destination = destination.canonicalize().with_context(|| {
            format!(
                "failed to resolve published generation '{}'",
                destination.display()
            )
        })?;
        let active = ActiveImage {
            schema_version: ACTIVE_SCHEMA_VERSION,
            generation,
            path: destination,
            sha256,
            bytes: validation.bytes,
            published_at_unix_ms: unix_time_ms()?,
            has_boot_signature: validation.has_boot_signature,
        };
        self.write_active_image(&active)?;
        Ok(PublishResult {
            published: true,
            reused,
            active_image: active,
        })
    }

    fn attach_unlocked(&self, udc: Option<&str>, identity: &UsbIdentity) -> Result<AttachResult> {
        let active = self
            .read_active_image()?
            .context("no active image; publish a CDJ-compatible disk image first")?;
        let validated = validate_image(&active.path)?;
        if validated.bytes != active.bytes {
            bail!(
                "active generation '{}' changed size after publication",
                active.path.display()
            );
        }
        let current_hash = sha256_file(&active.path)?;
        if current_hash != active.sha256 {
            bail!(
                "active generation '{}' changed after publication",
                active.path.display()
            );
        }

        let before = self.status()?;
        if before.configured {
            let already_attached = before.attached
                && before.read_only == Some(true)
                && before
                    .backing_file
                    .as_ref()
                    .is_some_and(|path| canonical_or_original(path) == active.path);
            if already_attached {
                return Ok(AttachResult {
                    attached: true,
                    status: before,
                });
            }
            bail!(
                "USB gadget '{}' already exists in a different or partial state; detach it first",
                self.paths.gadget_name
            );
        }

        self.controller().attach(
            &active.path,
            udc,
            &identity.serial,
            &identity.manufacturer,
            &identity.product,
        )?;
        Ok(AttachResult {
            attached: true,
            status: self.status()?,
        })
    }

    fn controller(&self) -> GadgetController<'_, B> {
        GadgetController::new(
            &self.gadget_fs,
            &self.paths.configfs_root,
            &self.paths.udc_root,
            &self.paths.gadget_name,
        )
    }

    fn lock_lifecycle(&self) -> Result<File> {
        fs::create_dir_all(&self.paths.state_dir).with_context(|| {
            format!(
                "failed to create appliance state directory '{}'",
                self.paths.state_dir.display()
            )
        })?;
        let path = self.paths.state_dir.join(LOCK_FILE_NAME);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open lifecycle lock '{}'", path.display()))?;
        FileExt::lock_exclusive(&file)
            .with_context(|| format!("failed to lock '{}'", path.display()))?;
        Ok(file)
    }

    fn read_active_image(&self) -> Result<Option<ActiveImage>> {
        let path = self.paths.active_path();
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("failed to open '{}'", path.display()));
            }
        };
        let active: ActiveImage = serde_json::from_reader(BufReader::new(file))
            .with_context(|| format!("failed to parse '{}'", path.display()))?;
        if active.schema_version != ACTIVE_SCHEMA_VERSION {
            bail!(
                "unsupported active-image schema {} in '{}'",
                active.schema_version,
                path.display()
            );
        }
        Ok(Some(active))
    }

    fn write_active_image(&self, active: &ActiveImage) -> Result<()> {
        fs::create_dir_all(&self.paths.state_dir).with_context(|| {
            format!(
                "failed to create appliance state directory '{}'",
                self.paths.state_dir.display()
            )
        })?;
        let destination = self.paths.active_path();
        let temporary = self
            .paths
            .state_dir
            .join(format!(".active.{}.tmp", std::process::id()));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .with_context(|| format!("failed to create '{}'", temporary.display()))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, active)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        let file = writer
            .into_inner()
            .map_err(|error| error.into_error())
            .context("failed to finalize active-image state")?;
        file.sync_all()?;
        fs::rename(&temporary, &destination).with_context(|| {
            format!(
                "failed to atomically activate '{}' as '{}'",
                temporary.display(),
                destination.display()
            )
        })?;
        sync_directory(&self.paths.state_dir)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct ImageValidation {
    bytes: u64,
    has_boot_signature: bool,
}

fn validate_image(path: &Path) -> Result<ImageValidation> {
    let metadata = path
        .metadata()
        .with_context(|| format!("failed to inspect disk image '{}'", path.display()))?;
    if !metadata.is_file() {
        bail!("disk image '{}' is not a regular file", path.display());
    }
    if metadata.len() < 512 {
        bail!(
            "disk image '{}' is smaller than one 512-byte sector",
            path.display()
        );
    }
    if metadata.len() % 512 != 0 {
        bail!(
            "disk image '{}' is not aligned to 512-byte sectors",
            path.display()
        );
    }
    let mut sector = [0_u8; 512];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut sector))
        .with_context(|| format!("failed to read first sector from '{}'", path.display()))?;
    Ok(ImageValidation {
        bytes: metadata.len(),
        has_boot_signature: sector[510..] == [0x55, 0xaa],
    })
}

fn sha256_file(path: &Path) -> Result<String> {
    let file = File::open(path)
        .with_context(|| format!("failed to open disk image '{}'", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .with_context(|| format!("failed to hash disk image '{}'", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn copy_generation(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
    expected_bytes: u64,
) -> Result<()> {
    let parent = destination
        .parent()
        .context("generation destination has no parent directory")?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("generation"),
        std::process::id()
    ));
    let copy_result = (|| -> Result<()> {
        let mut input = BufReader::new(
            File::open(source)
                .with_context(|| format!("failed to open source image '{}'", source.display()))?,
        );
        let output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .with_context(|| {
                format!("failed to create temporary image '{}'", temporary.display())
            })?;
        let mut output = BufWriter::new(output);
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let read = input
                .read(&mut buffer)
                .with_context(|| format!("failed to read source image '{}'", source.display()))?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read]).with_context(|| {
                format!(
                    "failed to copy '{}' to '{}'",
                    source.display(),
                    temporary.display()
                )
            })?;
            digest.update(&buffer[..read]);
            bytes = bytes
                .checked_add(u64::try_from(read).context("copy size does not fit in u64")?)
                .context("copy size overflowed u64")?;
        }
        let copied_sha256 = format!("{:x}", digest.finalize());
        if bytes != expected_bytes || copied_sha256 != expected_sha256 {
            bail!(
                "source image '{}' changed while it was being published",
                source.display()
            );
        }
        output.flush()?;
        let output = output
            .into_inner()
            .map_err(|error| error.into_error())
            .context("failed to finalize disk-image generation")?;
        output.sync_all()?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o440))?;
        fs::rename(&temporary, destination).with_context(|| {
            format!(
                "failed to publish '{}' as '{}'",
                temporary.display(),
                destination.display()
            )
        })?;
        sync_directory(parent)?;
        Ok(())
    })();
    if copy_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copy_result
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .with_context(|| format!("failed to open directory '{}'", path.display()))?
        .sync_all()
        .with_context(|| format!("failed to sync directory '{}'", path.display()))
}

fn unix_time_ms() -> Result<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_millis();
    u64::try_from(millis).context("system time does not fit in u64 milliseconds")
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn validate_gadget_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("gadget name must be 1-64 ASCII letters, digits, '.', '_', or '-'");
    }
    Ok(())
}

fn validate_usb_string(name: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 126 || value.contains(['\0', '\n', '\r']) {
        bail!("{name} must be 1-126 characters without NUL or newlines");
    }
    Ok(())
}

fn default_serial() -> String {
    fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|value| {
            value
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .take(32)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "djbooth.ai".to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    use tempfile::TempDir;

    use super::*;

    #[derive(Default)]
    struct MemoryGadgetFs {
        directories: RefCell<HashSet<PathBuf>>,
        files: RefCell<HashMap<PathBuf, String>>,
        links: RefCell<HashMap<PathBuf, PathBuf>>,
    }

    impl MemoryGadgetFs {
        fn directory(&self, path: impl Into<PathBuf>) {
            self.directories.borrow_mut().insert(path.into());
        }

        fn file(&self, path: impl Into<PathBuf>, value: impl Into<String>) {
            self.files.borrow_mut().insert(path.into(), value.into());
        }
    }

    impl GadgetFs for MemoryGadgetFs {
        fn exists(&self, path: &Path) -> bool {
            self.directories.borrow().contains(path)
                || self.files.borrow().contains_key(path)
                || self.links.borrow().contains_key(path)
        }

        fn create_dir(&self, path: &Path) -> Result<()> {
            self.directories.borrow_mut().insert(path.to_path_buf());
            Ok(())
        }

        fn write_attr(&self, path: &Path, value: &str) -> Result<()> {
            self.files
                .borrow_mut()
                .insert(path.to_path_buf(), value.to_string());
            Ok(())
        }

        fn read_attr(&self, path: &Path) -> Result<Option<String>> {
            Ok(self.files.borrow().get(path).cloned())
        }

        fn create_symlink(&self, target: &Path, link: &Path) -> Result<()> {
            self.links
                .borrow_mut()
                .insert(link.to_path_buf(), target.to_path_buf());
            Ok(())
        }

        fn remove_link(&self, path: &Path) -> Result<()> {
            self.links.borrow_mut().remove(path);
            Ok(())
        }

        fn remove_dir(&self, path: &Path) -> Result<()> {
            self.directories
                .borrow_mut()
                .retain(|candidate| !candidate.starts_with(path));
            self.files
                .borrow_mut()
                .retain(|candidate, _| !candidate.starts_with(path));
            self.links
                .borrow_mut()
                .retain(|candidate, _| !candidate.starts_with(path));
            Ok(())
        }

        fn list_dir_names(&self, path: &Path) -> Result<Vec<String>> {
            let mut names = self
                .directories
                .borrow()
                .iter()
                .filter_map(|candidate| {
                    (candidate.parent() == Some(path))
                        .then(|| candidate.file_name()?.to_str().map(ToOwned::to_owned))
                        .flatten()
                })
                .collect::<Vec<_>>();
            names.sort();
            Ok(names)
        }
    }

    fn fixture() -> (TempDir, Appliance<MemoryGadgetFs>, PathBuf) {
        let root = tempfile::tempdir().expect("temporary root");
        let state = root.path().join("state");
        let configfs = PathBuf::from("/configfs");
        let udcs = PathBuf::from("/udc");
        let backend = MemoryGadgetFs::default();
        backend.directory(&configfs);
        backend.directory(&udcs);
        backend.directory(udcs.join("udc0"));
        backend.file(udcs.join("udc0/state"), "configured");
        let paths =
            AppliancePaths::new(state, configfs, udcs, "music".to_string()).expect("valid paths");
        let appliance = Appliance::new(paths, backend);
        let image = root.path().join("rekordbox.img");
        let mut bytes = vec![0_u8; 1024 * 1024];
        bytes[510] = 0x55;
        bytes[511] = 0xaa;
        fs::write(&image, bytes).expect("fixture image");
        (root, appliance, image)
    }

    fn identity() -> UsbIdentity {
        UsbIdentity::new(
            Some("test-device".to_string()),
            "djbooth.ai".to_string(),
            "CDJ USB".to_string(),
        )
        .expect("valid USB identity")
    }

    #[test]
    fn publishes_content_addressed_immutable_generations() {
        let (_root, appliance, image) = fixture();
        let first = appliance.publish(&image).expect("first publish");
        let second = appliance.publish(&image).expect("second publish");

        assert!(!first.reused);
        assert!(second.reused);
        assert_eq!(first.active_image.sha256, second.active_image.sha256);
        assert_eq!(first.active_image.generation.len(), 64);
        assert_eq!(first.active_image.bytes, 1024 * 1024);
        assert!(first.active_image.has_boot_signature);
        assert_eq!(
            first
                .active_image
                .path
                .metadata()
                .expect("generation metadata")
                .permissions()
                .mode()
                & 0o777,
            0o440
        );
    }

    #[test]
    fn rejects_a_mutated_content_addressed_generation() {
        let (_root, appliance, image) = fixture();
        let published = appliance.publish(&image).expect("first publish");
        fs::set_permissions(
            &published.active_image.path,
            fs::Permissions::from_mode(0o640),
        )
        .expect("make fixture writable");
        let mut corrupted = fs::read(&published.active_image.path).expect("read generation");
        corrupted[0] = 1;
        fs::write(&published.active_image.path, corrupted).expect("corrupt generation");

        let error = appliance.publish(&image).expect_err("reuse must fail");
        assert!(
            error
                .to_string()
                .contains("does not match its content-addressed name")
        );
    }

    #[test]
    fn attaches_only_a_read_only_active_generation() {
        let (_root, appliance, image) = fixture();
        let published = appliance.publish(&image).expect("publish");
        let attached = appliance.attach(None, &identity()).expect("attach");

        assert!(attached.status.configured);
        assert!(attached.status.attached);
        assert_eq!(attached.status.udc.as_deref(), Some("udc0"));
        assert_eq!(attached.status.read_only, Some(true));
        assert_eq!(
            attached.status.backing_file.as_deref(),
            Some(published.active_image.path.as_path())
        );
        assert!(!attached.status.safe_to_publish);
    }

    #[test]
    fn refuses_publication_while_the_kernel_holds_a_generation() {
        let (root, appliance, image) = fixture();
        appliance.run(&image, None, &identity()).expect("run");
        let other = root.path().join("other.img");
        let mut bytes = vec![1_u8; 1024 * 1024];
        bytes[510] = 0x55;
        bytes[511] = 0xaa;
        fs::write(&other, bytes).expect("other image");

        let error = appliance.publish(&other).expect_err("publish must fail");
        assert!(error.to_string().contains("detach it before publishing"));
    }

    #[test]
    fn requires_host_eject_confirmation_before_unbinding() {
        let (_root, appliance, image) = fixture();
        appliance.run(&image, None, &identity()).expect("run");

        let error = appliance.detach(false).expect_err("detach must fail");
        assert!(error.to_string().contains("confirm-host-ejected"));

        let detached = appliance.detach(true).expect("confirmed detach");
        assert!(detached.detached);
        assert!(!detached.status.configured);
        assert!(detached.status.safe_to_publish);
    }

    #[test]
    fn rejects_non_sector_aligned_images() {
        let (root, appliance, _image) = fixture();
        let image = root.path().join("bad.img");
        fs::write(&image, vec![0_u8; 513]).expect("bad image");

        let error = appliance.publish(&image).expect_err("publish must fail");
        assert!(
            error
                .to_string()
                .contains("not aligned to 512-byte sectors")
        );
    }
}
