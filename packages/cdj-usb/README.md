# @gakonst/cdj-usb

CDJ-3000 front-USB export and Linux-appliance support. The normal content workflow compiles the
ordinary Rekordbox `master.db` directly onto a mounted FAT/exFAT media root:

```text
Rekordbox master.db + local audio + ANLZ
                    |
             music usb export
                    |
      Contents/ + PIONEER/USBANLZ/
       + PIONEER/rekordbox/export.pdb
```

This is the legacy Device Library format used by CDJ-3000 media. It does not create Device Library
Plus, mutate the source SQLite database, or require a disk-image file.

The package also contains a lower-level Linux configfs controller for presenting an immutable
backing image through a board's USB device/OTG port. In that mode the deck remains the USB host, the
board is self-powered, and the gadget is read-only. Linux serves subsequent block reads after the
controller exits, so there is no userspace server on the playback path.

## Current boundary

The exporter:

- reads an open `MasterDatabase` or discovers/opens `master.db` read-only;
- generates `PIONEER/rekordbox/export.pdb` from active tracks and playlists;
- copies MP3, M4A, FLAC, WAV, or AIFF audio beneath `Contents/`;
- copies DAT/EXT/2EX analysis beneath `PIONEER/USBANLZ/` and rewrites every `PPTH`;
- materializes regular and smart playlists while preserving order and duplicate memberships;
- stages the complete result and replaces only an earlier music-ts-owned export.

The current low-level gadget controller:

- imports a complete block image into content-addressed, immutable appliance storage;
- atomically selects one active generation only while the gadget is detached;
- exposes exactly one read-only, removable USB mass-storage LUN;
- discovers Linux USB device controllers instead of assuming a board;
- refuses to unbind a configured host without an explicit physical-eject confirmation;
- reports the kernel UDC state, backing file, active generation, and preflight checks as typed JSON.

The two operations are intentionally separate. `export` writes a mounted directory. The current
`publish`/`attach` transport still consumes a complete backing image; it does not hot-mount or
modify media while the CDJ owns it. Actual CDJ-3000 enumeration and browsing remain a hardware
validation gate.

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

## Export a CDJ-3000 library

Export to the root of mounted FAT/exFAT media or to a staging directory:

```sh
music usb export /mnt/cdj --database /path/to/master.db --format json
```

The result contains:

```text
/mnt/cdj/
├── .music-cdj-export.json
├── Contents/...
└── PIONEER/
    ├── USBANLZ/...
    └── rekordbox/export.pdb
```

SQLite remains authoritative; `export.pdb` is disposable compiled output. Tracks missing a regular
local audio file or `ANLZ0000.DAT` fail the whole staged export. To update media created by this
command:

```sh
music usb export /mnt/cdj --database /path/to/master.db --replace --format json
```

`--replace` refuses to touch a Rekordbox-created or otherwise unowned export.

## Low-level image transport

The current configfs controller starts with a detached appliance and a complete backing image:

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
import {
  attachCdjUsb,
  doctorCdjUsb,
  exportLegacyDeviceLibrary,
  publishCdjUsbImage,
  statusCdjUsb,
} from "@gakonst/cdj-usb";

await exportLegacyDeviceLibrary({
  databasePath: "/path/to/master.db",
  targetDirectory: "/mnt/cdj",
});

const preflight = await doctorCdjUsb({ imagePath: "./rekordbox-usb.img" });
if (!preflight.ok) throw new Error("USB appliance preflight failed");

await publishCdjUsbImage({ imagePath: "./rekordbox-usb.img" });
await attachCdjUsb();
console.log(await statusCdjUsb());
```

`MUSIC_CDJ_USB_BINARY` selects an explicit native helper. Tests and board bring-up can override
`stateDir`, `configfsRoot`, and `udcRoot`; normal deployments should retain the root-owned defaults.
