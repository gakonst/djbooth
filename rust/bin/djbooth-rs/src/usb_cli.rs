use std::path::PathBuf;

use crate::usb::{Appliance, AppliancePaths, SystemGadgetFs, UsbIdentity};
use anyhow::Result;
use clap::{Parser, Subcommand};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(
    name = "djbooth-rs usb",
    version,
    about = "Safely publish a CDJ-compatible image through Linux USB mass storage"
)]
struct Cli {
    #[arg(
        long,
        global = true,
        default_value = "/var/lib/djbooth-cdj-usb",
        help = "Immutable generations and active-image state"
    )]
    state_dir: PathBuf,

    #[arg(
        long,
        global = true,
        default_value = "/sys/kernel/config/usb_gadget",
        help = "Linux configfs usb_gadget root"
    )]
    configfs_root: PathBuf,

    #[arg(
        long,
        global = true,
        default_value = "/sys/class/udc",
        help = "Linux USB device-controller sysfs root"
    )]
    udc_root: PathBuf,

    #[arg(
        long,
        global = true,
        default_value = "djbooth",
        help = "configfs gadget directory name"
    )]
    gadget_name: String,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect the platform, image, configfs, UDC, and current attachment.
    Doctor {
        #[arg(
            long,
            help = "Candidate image to validate instead of the active generation"
        )]
        image: Option<PathBuf>,
    },
    /// Import an immutable image generation and atomically make it active.
    Publish {
        #[arg(value_name = "IMAGE")]
        image: PathBuf,
    },
    /// Bind the active image read-only to one USB device controller.
    Attach {
        #[arg(long, help = "Explicit UDC name; required when more than one exists")]
        udc: Option<String>,
        #[arg(long, help = "Stable USB serial; defaults to the machine ID")]
        serial: Option<String>,
        #[arg(long, default_value = "djbooth.ai")]
        manufacturer: String,
        #[arg(long, default_value = "CDJ USB")]
        product: String,
    },
    /// Unbind the USB gadget and release its backing image.
    Detach {
        #[arg(
            long,
            help = "Confirm the deck has ejected the device before an attached gadget is unbound"
        )]
        confirm_host_ejected: bool,
    },
    /// Show the active image and kernel USB gadget state.
    Status,
    /// Publish one image and bind it read-only under one exclusive lifecycle lock.
    Run {
        #[arg(value_name = "IMAGE")]
        image: PathBuf,
        #[arg(long, help = "Explicit UDC name; required when more than one exists")]
        udc: Option<String>,
        #[arg(long, help = "Stable USB serial; defaults to the machine ID")]
        serial: Option<String>,
        #[arg(long, default_value = "djbooth.ai")]
        manufacturer: String,
        #[arg(long, default_value = "CDJ USB")]
        product: String,
    },
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<()> {
    let cli = Cli::parse_from(std::iter::once("djbooth-rs usb".to_string()).chain(args));
    let paths = AppliancePaths::new(
        cli.state_dir,
        cli.configfs_root,
        cli.udc_root,
        cli.gadget_name,
    )?;
    let appliance = Appliance::new(paths, SystemGadgetFs);

    match cli.command {
        Command::Doctor { image } => print_json(&appliance.doctor(image.as_deref())?),
        Command::Publish { image } => print_json(&appliance.publish(&image)?),
        Command::Attach {
            udc,
            serial,
            manufacturer,
            product,
        } => print_json(&appliance.attach(
            udc.as_deref(),
            &UsbIdentity::new(serial, manufacturer, product)?,
        )?),
        Command::Detach {
            confirm_host_ejected,
        } => print_json(&appliance.detach(confirm_host_ejected)?),
        Command::Status => print_json(&appliance.status()?),
        Command::Run {
            image,
            udc,
            serial,
            manufacturer,
            product,
        } => print_json(&appliance.run(
            &image,
            udc.as_deref(),
            &UsbIdentity::new(serial, manufacturer, product)?,
        )?),
    }
}

fn print_json(value: &impl Serialize) -> Result<()> {
    serde_json::to_writer(std::io::stdout().lock(), value)?;
    println!();
    Ok(())
}
