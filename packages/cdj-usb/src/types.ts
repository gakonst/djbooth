/** One immutable disk-image generation retained by the appliance. */
export type CdjUsbActiveImage = {
  schemaVersion: 1;
  generation: string;
  path: string;
  sha256: string;
  bytes: number;
  publishedAtUnixMs: number;
  hasBootSignature: boolean;
};

/** Current Linux USB gadget and active-generation state. */
export type CdjUsbStatus = {
  schemaVersion: 1;
  gadgetName: string;
  configured: boolean;
  attached: boolean;
  safeToPublish: boolean;
  udc: string | null;
  hostState: string | null;
  backingFile: string | null;
  readOnly: boolean | null;
  activeImage: CdjUsbActiveImage | null;
};

/** One non-mutating appliance preflight check. */
export type CdjUsbDoctorCheck = {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
};

/** Linux/configfs, image, and gadget preflight report. */
export type CdjUsbDoctorResult = {
  ok: boolean;
  checks: CdjUsbDoctorCheck[];
  status: CdjUsbStatus;
};

/** Result of importing and atomically activating an immutable image generation. */
export type CdjUsbPublishResult = {
  published: true;
  reused: boolean;
  activeImage: CdjUsbActiveImage;
};

/** Result of binding the active image to a Linux USB device controller. */
export type CdjUsbAttachResult = {
  attached: true;
  status: CdjUsbStatus;
};

/** Result of unbinding and removing the Linux USB gadget. */
export type CdjUsbDetachResult = {
  detached: boolean;
  status: CdjUsbStatus;
};

/** Atomic publish-then-attach result. */
export type CdjUsbRunResult = {
  publish: CdjUsbPublishResult;
  attach: CdjUsbAttachResult;
};
