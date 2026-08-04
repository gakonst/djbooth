/** Rekordbox legacy USB analysis location derived from the USB-relative audio path. */
export function legacyUsbAnalysisPath(usbAudioPath: string): string {
  if (!usbAudioPath.startsWith("/Contents/"))
    throw new TypeError(`Legacy USB audio path must start with '/Contents/': '${usbAudioPath}'`);

  let hash = 0;
  for (let index = 0; index < usbAudioPath.length; index++) {
    const codeUnit = usbAudioPath.charCodeAt(index);
    const intermediate = (Math.imul(hash, 0x5bc9) + codeUnit) >>> 0;
    hash = (Math.imul(intermediate, 0x93b5) + codeUnit) >>> 0;
  }

  const pathHash = hash % 200_003;
  let bucket = 0;
  bucket |= pathHash & 0x01;
  bucket |= (pathHash >>> 1) & 0x02;
  bucket |= (pathHash >>> 4) & 0x04;
  bucket |= (pathHash >>> 4) & 0x08;
  bucket |= (pathHash >>> 5) & 0x10;
  bucket |= (pathHash >>> 8) & 0x20;
  bucket |= (pathHash >>> 10) & 0x40;

  const bucketHex = bucket.toString(16).toUpperCase().padStart(3, "0");
  const hashHex = pathHash.toString(16).toUpperCase().padStart(8, "0");
  return `/PIONEER/USBANLZ/P${bucketHex}/${hashHex}/ANLZ0000.DAT`;
}
