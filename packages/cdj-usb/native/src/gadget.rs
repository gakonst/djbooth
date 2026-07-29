use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KernelGadgetStatus {
    pub configured: bool,
    pub attached: bool,
    pub udc: Option<String>,
    pub host_state: Option<String>,
    pub backing_file: Option<PathBuf>,
    pub read_only: Option<bool>,
}

pub trait GadgetFs {
    fn exists(&self, path: &Path) -> bool;
    fn create_dir(&self, path: &Path) -> Result<()>;
    fn write_attr(&self, path: &Path, value: &str) -> Result<()>;
    fn read_attr(&self, path: &Path) -> Result<Option<String>>;
    fn create_symlink(&self, target: &Path, link: &Path) -> Result<()>;
    fn remove_link(&self, path: &Path) -> Result<()>;
    fn remove_dir(&self, path: &Path) -> Result<()>;
    fn list_dir_names(&self, path: &Path) -> Result<Vec<String>>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemGadgetFs;

impl GadgetFs for SystemGadgetFs {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn create_dir(&self, path: &Path) -> Result<()> {
        fs::create_dir(path).with_context(|| format!("failed to create '{}'", path.display()))
    }

    fn write_attr(&self, path: &Path, value: &str) -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .open(path)
            .with_context(|| format!("failed to open configfs attribute '{}'", path.display()))?;
        let bytes = if value.is_empty() {
            b"\n".as_slice()
        } else {
            value.as_bytes()
        };
        file.write_all(bytes)
            .with_context(|| format!("failed to write configfs attribute '{}'", path.display()))
    }

    fn read_attr(&self, path: &Path) -> Result<Option<String>> {
        match fs::read_to_string(path) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => {
                Err(error).with_context(|| format!("failed to read '{}'", path.display()))
            }
        }
    }

    fn create_symlink(&self, target: &Path, link: &Path) -> Result<()> {
        symlink(target, link).with_context(|| {
            format!(
                "failed to link USB function '{}' to '{}'",
                target.display(),
                link.display()
            )
        })
    }

    fn remove_link(&self, path: &Path) -> Result<()> {
        fs::remove_file(path).with_context(|| format!("failed to unlink '{}'", path.display()))
    }

    fn remove_dir(&self, path: &Path) -> Result<()> {
        fs::remove_dir(path).with_context(|| format!("failed to remove '{}'", path.display()))
    }

    fn list_dir_names(&self, path: &Path) -> Result<Vec<String>> {
        let mut names = fs::read_dir(path)
            .with_context(|| format!("failed to list '{}'", path.display()))?
            .filter_map(|entry| {
                entry.ok().and_then(|entry| {
                    entry
                        .file_type()
                        .ok()
                        .filter(|kind| kind.is_dir() || kind.is_symlink())
                        .and_then(|_| entry.file_name().into_string().ok())
                })
            })
            .collect::<Vec<_>>();
        names.sort();
        Ok(names)
    }
}

pub(crate) struct GadgetController<'a, B: GadgetFs> {
    fs: &'a B,
    configfs_root: &'a Path,
    udc_root: &'a Path,
    gadget_name: &'a str,
}

impl<'a, B: GadgetFs> GadgetController<'a, B> {
    pub fn new(
        fs: &'a B,
        configfs_root: &'a Path,
        udc_root: &'a Path,
        gadget_name: &'a str,
    ) -> Self {
        Self {
            fs,
            configfs_root,
            udc_root,
            gadget_name,
        }
    }

    pub fn status(&self) -> Result<KernelGadgetStatus> {
        let gadget = self.gadget_path();
        if !self.fs.exists(&gadget) {
            return Ok(KernelGadgetStatus {
                configured: false,
                attached: false,
                udc: None,
                host_state: None,
                backing_file: None,
                read_only: None,
            });
        }
        let udc = self
            .fs
            .read_attr(&gadget.join("UDC"))?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let host_state = udc
            .as_ref()
            .and_then(|name| {
                self.fs
                    .read_attr(&self.udc_root.join(name).join("state"))
                    .transpose()
            })
            .transpose()?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let backing_file = self
            .fs
            .read_attr(&gadget.join("functions/mass_storage.0/lun.0/file"))?
            .map(|value| PathBuf::from(value.trim()))
            .filter(|value| !value.as_os_str().is_empty());
        let read_only = self
            .fs
            .read_attr(&gadget.join("functions/mass_storage.0/lun.0/ro"))?
            .map(|value| matches!(value.trim(), "1" | "Y" | "y"));
        Ok(KernelGadgetStatus {
            configured: true,
            attached: udc.is_some(),
            udc,
            host_state,
            backing_file,
            read_only,
        })
    }

    pub fn attach(
        &self,
        image: &Path,
        requested_udc: Option<&str>,
        serial: &str,
        manufacturer: &str,
        product: &str,
    ) -> Result<()> {
        if !self.fs.exists(self.configfs_root) {
            bail!(
                "configfs USB gadget root '{}' is missing; mount configfs and load libcomposite",
                self.configfs_root.display()
            );
        }
        let udc = self.select_udc(requested_udc)?;
        let gadget = self.gadget_path();
        if self.fs.exists(&gadget) {
            bail!(
                "USB gadget '{}' already exists; detach it before reconfiguration",
                gadget.display()
            );
        }

        let configured = (|| -> Result<()> {
            self.fs.create_dir(&gadget)?;
            self.write(&gadget, "idVendor", "0x1d6b")?;
            self.write(&gadget, "idProduct", "0x0104")?;
            self.write(&gadget, "bcdDevice", "0x0100")?;
            self.write(&gadget, "bcdUSB", "0x0200")?;
            self.write(&gadget, "bDeviceClass", "0x00")?;

            let strings = gadget.join("strings/0x409");
            self.fs.create_dir(&strings)?;
            self.write(&strings, "serialnumber", serial)?;
            self.write(&strings, "manufacturer", manufacturer)?;
            self.write(&strings, "product", product)?;

            let config = gadget.join("configs/c.1");
            self.fs.create_dir(&config)?;
            self.write(&config, "bmAttributes", "0xC0")?;
            self.write(&config, "MaxPower", "2")?;
            let config_strings = config.join("strings/0x409");
            self.fs.create_dir(&config_strings)?;
            self.write(&config_strings, "configuration", "Read-only mass storage")?;

            let function = gadget.join("functions/mass_storage.0");
            self.fs.create_dir(&function)?;
            self.write(&function, "stall", "1")?;
            self.write(&function, "lun.0/ro", "1")?;
            self.write(&function, "lun.0/removable", "1")?;
            self.write(&function, "lun.0/cdrom", "0")?;
            self.write(&function, "lun.0/nofua", "0")?;
            self.write(&function, "lun.0/file", &image.display().to_string())?;
            self.fs
                .create_symlink(&function, &config.join("mass_storage.0"))?;
            self.write(&gadget, "UDC", &udc)?;
            Ok(())
        })();

        if let Err(error) = configured {
            let cleanup = self.cleanup();
            return match cleanup {
                Ok(()) => Err(error).context("failed to configure read-only USB mass storage"),
                Err(cleanup_error) => Err(error).context(format!(
                    "failed to configure USB mass storage; cleanup also failed: {cleanup_error:#}"
                )),
            };
        }
        Ok(())
    }

    pub fn detach(&self, confirm_host_ejected: bool) -> Result<()> {
        let status = self.status()?;
        if !status.configured {
            return Ok(());
        }
        let host_may_be_using_media = status.attached
            && !matches!(
                status.host_state.as_deref(),
                Some("not attached") | Some("powered")
            );
        if host_may_be_using_media && !confirm_host_ejected {
            bail!(
                "USB host state is '{}'; eject or USB STOP on the deck, then repeat with --confirm-host-ejected",
                status.host_state.as_deref().unwrap_or("unknown")
            );
        }
        if status.attached {
            self.write(&self.gadget_path(), "UDC", "")?;
        }
        self.cleanup()
    }

    fn cleanup(&self) -> Result<()> {
        let gadget = self.gadget_path();
        if !self.fs.exists(&gadget) {
            return Ok(());
        }
        let link = gadget.join("configs/c.1/mass_storage.0");
        if self.fs.exists(&link) {
            self.fs.remove_link(&link)?;
        }
        for directory in [
            gadget.join("configs/c.1/strings/0x409"),
            gadget.join("configs/c.1"),
            gadget.join("functions/mass_storage.0"),
            gadget.join("strings/0x409"),
            gadget.clone(),
        ] {
            if self.fs.exists(&directory) {
                self.fs.remove_dir(&directory)?;
            }
        }
        Ok(())
    }

    fn select_udc(&self, requested: Option<&str>) -> Result<String> {
        let available = self.fs.list_dir_names(self.udc_root).with_context(|| {
            format!(
                "failed to discover USB device controllers under '{}'",
                self.udc_root.display()
            )
        })?;
        if let Some(requested) = requested {
            if requested.contains('/') || requested.contains('\0') {
                bail!("UDC name must be one sysfs directory name");
            }
            if available.iter().any(|candidate| candidate == requested) {
                return Ok(requested.to_string());
            }
            bail!(
                "USB device controller '{requested}' is unavailable; found: {}",
                available.join(", ")
            );
        }
        match available.as_slice() {
            [] => bail!(
                "no USB device controller found under '{}'; this board/port may not support peripheral mode",
                self.udc_root.display()
            ),
            [only] => Ok(only.clone()),
            many => bail!(
                "multiple USB device controllers found ({}); select one with --udc",
                many.join(", ")
            ),
        }
    }

    fn gadget_path(&self) -> PathBuf {
        self.configfs_root.join(self.gadget_name)
    }

    fn write(&self, root: &Path, relative: &str, value: &str) -> Result<()> {
        self.fs.write_attr(&root.join(relative), value)
    }
}
