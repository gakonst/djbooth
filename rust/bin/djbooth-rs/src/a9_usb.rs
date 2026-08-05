use std::time::Duration;

use anyhow::{Context, Result, bail};
use nusb::MaybeFuture;
use nusb::transfer::{ControlOut, ControlType, Recipient};

const PIONEER_VENDOR_ID: u16 = 0x2b73;
const DJM_A9_PRODUCT_ID: u16 = 0x003c;
const SET_MIXER_OUTPUT_REQUEST: u8 = 0x03;
const SET_MIXER_OUTPUT_INDEX: u16 = 0x8002;
const CONTROL_TIMEOUT: Duration = Duration::from_millis(250);

// DJM-A9 mixer-output route words. These are the values accepted by the
// device's vendor control request, not Setup Utility menu indexes.
const MASTER_REC_OUT_WITH_MIC: u16 = 0x010a;
const PRE_CHANNEL_FADER: [u16; 4] = [0x0205, 0x0305, 0x0405, 0x0505];

#[derive(Clone, Copy, Debug)]
pub(crate) struct A9MeterRouting {
    pub(crate) master_pair: &'static str,
    pub(crate) channel_pairs: [&'static str; 4],
}

pub(crate) fn configure_meter_routes() -> Result<A9MeterRouting> {
    let info = nusb::list_devices()
        .wait()
        .context("enumerate USB devices")?
        .find(|device| {
            device.vendor_id() == PIONEER_VENDOR_ID && device.product_id() == DJM_A9_PRODUCT_ID
        })
        .context("DJM-A9 USB device is not connected")?;
    let device = info.open().wait().context("open DJM-A9 USB device")?;

    for route in [MASTER_REC_OUT_WITH_MIC]
        .into_iter()
        .chain(PRE_CHANNEL_FADER)
    {
        device
            .control_out(
                ControlOut {
                    control_type: ControlType::Vendor,
                    recipient: Recipient::Device,
                    request: SET_MIXER_OUTPUT_REQUEST,
                    value: route,
                    index: SET_MIXER_OUTPUT_INDEX,
                    data: &[],
                },
                CONTROL_TIMEOUT,
            )
            .wait()
            .with_context(|| format!("set DJM-A9 USB meter route 0x{route:04x}"))?;
    }

    // Keep this explicit: USB1/2 is the A9's general-purpose output pair;
    // USB3/4 through USB9/10 correspond to mixer channels 1 through 4.
    let routing = A9MeterRouting {
        master_pair: "usb.1_2",
        channel_pairs: ["usb.3_4", "usb.5_6", "usb.7_8", "usb.9_10"],
    };
    if routing.channel_pairs.len() != PRE_CHANNEL_FADER.len() {
        bail!("internal DJM-A9 meter route mismatch");
    }
    Ok(routing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_master_then_four_prefader_channels() {
        assert_eq!(MASTER_REC_OUT_WITH_MIC, 0x010a);
        assert_eq!(PRE_CHANNEL_FADER, [0x0205, 0x0305, 0x0405, 0x0505]);
    }
}
