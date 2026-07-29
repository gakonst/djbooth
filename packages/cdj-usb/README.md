# @gakonst/cdj-usb

Linux appliance controller for presenting one prepared CDJ-compatible block image through a
front-panel USB port. The deck remains the USB host. The board is self-powered and behaves as a
read-only USB mass-storage device:

```text
Wi-Fi / application pipeline
            |
   private working storage
            |
   publish immutable image generation
            |
Linux configfs + mass_storage.0
            |
 board USB device/OTG port ── one cable ── CDJ front USB-A
```

The native Rust controller configures the gadget and exits. Linux serves subsequent block reads, so
there is no userspace server on the playback path.

## Current boundary

This package deliberately starts with the transport and publication-safety boundary:

- imports a complete block image into content-addressed, immutable appliance storage;
- atomically selects one active generation only while the gadget is detached;
- exposes exactly one read-only, removable USB mass-storage LUN;
- discovers Linux USB device controllers instead of assuming a board;
- refuses to unbind a configured host without an explicit physical-eject confirmation;
- reports the kernel UDC state, backing file, active generation, and preflight checks as typed JSON.

It does **not** claim to synthesize every Rekordbox USB format. `@gakonst/rekordbox` can read and
mutate Device Library Plus `exportLibrary.db`, but the repository does not yet contain a legacy
`export.pdb` publisher for CDJ-3000-class media. For the first hardware proof, publish an image
prepared by Rekordbox. A later publisher can build an inactive image and hand it to this package
without weakening the attach/swap boundary.

## Board requirement

The board must expose the connector wired to the deck as a USB **device/peripheral**, not merely a
USB host. Check the running kernel before buying more hardware:

```sh
ls -1 /sys/class/udc
```

At least one name must appear. `music usb doctor` performs the same check.

Orange Pi model names matter:

- Orange Pi Zero 2W documents USB0 device mode and normally leaves USB0 in device mode on its Linux
  images. [Official board wiki](https://www.orangepi.org/orangepiwiki/index.php/Orange_Pi_Zero_2W)
- Orange Pi 3B specifies one USB 2.0 interface supporting host or device mode.
  [Official specification](https://www.orangepi.org/html/hardWare/computerAndMicrocontrollers/details/Orange-Pi-3B.html)
- Orange Pi Zero 3 documentation describes its exposed USB interfaces as host ports. Treat that
  model as unsupported unless its exact board revision, device tree, and connector produce a UDC.
  [Official board wiki](https://www.orangepi.org/orangepiwiki/index.php/Orange_Pi_Zero_3)

Raspberry Pi 4/5 and Compute Modules also support peripheral mode, but this package has no
Raspberry-specific runtime dependency.

## Power boundary

Power the board from a protected battery/UPS capable of its full 5 V load. The USB cable to the deck
is the data connection; do not rely on the deck to power the computer.

A production carrier or cable must prevent the battery supply from back-feeding USB VBUS. Pass D+,
D-, ground, and the host-presence signal required by the board while isolating or correctly
power-ORing VBUS. Do not tie a battery regulator and the deck's 5 V rail together.

Use a UPS with:

- sufficient continuous and peak current for the board, storage, Wi-Fi, and cooling;
- battery protection, fuel gauge, low-voltage cutoff, and a real power path;
- a shutdown signal or service that invokes an orderly OS shutdown before cutoff;
- a separate charge input exposed on the enclosure.

Because the exported LUN is read-only, sudden battery shutdown cannot partially write the deck's
filesystem. Private acquisition and analysis state still needs normal durable-write and shutdown
handling.

## Build

Node.js 22, the workspace pnpm version, Rust, and Rust nightly formatting are required:

```sh
pnpm install
pnpm --filter @gakonst/cdj-usb native:build
pnpm --filter @gakonst/cdj-usb check
```

Install the native controller on the target Linux board:

```sh
sudo install -m 0755 \
  packages/cdj-usb/native-bin/music-cdj-usb \
  /usr/local/bin/music-cdj-usb
```

Enable the board's USB controller in peripheral mode according to its device tree, then make
configfs and the composite gadget framework available:

```sh
sudo modprobe libcomposite
sudo mount -t configfs none /sys/kernel/config 2>/dev/null || true
ls -1 /sys/class/udc
```

The `dwc2` Raspberry Pi overlay is not portable to Allwinner or Rockchip Orange Pi boards. Use the
board's actual OTG controller/device-tree configuration.

## Safe lifecycle

Start with a detached appliance and a complete disk image:

```sh
music usb doctor ./rekordbox-usb.img --format json
sudo music usb publish ./rekordbox-usb.img --format json
sudo music usb attach --format json
music usb status --format json
```

`publish` validates a regular, non-empty, 512-byte-aligned file, hashes it, copies it into
`/var/lib/music-cdj-usb/generations/<sha256>.img`, makes that generation non-writable, fsyncs it,
and atomically replaces `active.json`. `attach` re-hashes the active generation before pointing
configfs at it.

The default USB identity is `music-ts / CDJ USB`; the machine ID supplies a stable serial. Select a
specific device controller only when the board exposes more than one:

```sh
sudo music usb attach --udc 5020000.usb --product "music USB" --format json
```

Before changing generations:

1. Stop playback from this USB source.
2. Press USB STOP/eject on the physical deck.
3. Confirm that step while detaching.
4. Publish the next complete image.
5. Attach again.

```sh
sudo music usb detach --confirm-host-ejected --format json
sudo music usb publish ./next-rekordbox-usb.img --format json
sudo music usb attach --format json
```

The kernel UDC can remain `configured` after a deck UI eject, so the confirmation is intentionally
human rather than inferred. Never mount or modify the active generation locally while it is
configured.

`run` is a locked first-boot convenience for a known-detached board:

```sh
sudo music usb run ./rekordbox-usb.img --format json
```

## systemd

[`deploy/music-cdj-usb.service`](./deploy/music-cdj-usb.service) binds an already-published active
image at boot. Install it only after `doctor` passes:

```sh
sudo install -m 0644 \
  packages/cdj-usb/deploy/music-cdj-usb.service \
  /etc/systemd/system/music-cdj-usb.service
sudo systemctl daemon-reload
sudo systemctl enable --now music-cdj-usb.service
```

Stopping the unit unbinds the gadget and is electrically equivalent to unplugging it. Stop it
manually only after deck eject. A low-battery shutdown may still remove the device from the deck;
the read-only LUN protects the filesystem, but it cannot preserve playback after power loss.

## Direct TypeScript API

```ts
import { attachCdjUsb, doctorCdjUsb, publishCdjUsbImage, statusCdjUsb } from "@gakonst/cdj-usb";

const preflight = await doctorCdjUsb({ imagePath: "./rekordbox-usb.img" });
if (!preflight.ok) throw new Error("USB appliance preflight failed");

await publishCdjUsbImage({ imagePath: "./rekordbox-usb.img" });
await attachCdjUsb();
console.log(await statusCdjUsb());
```

`MUSIC_CDJ_USB_BINARY` selects an explicit native helper. Tests and board bring-up can override
`stateDir`, `configfsRoot`, and `udcRoot`; normal deployments should retain the root-owned defaults.
