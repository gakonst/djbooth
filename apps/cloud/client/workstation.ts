/** Open the same workstation shipped in the native/local app. */
export async function openWorkstation(): Promise<void> {
  const target = new URL("/workstation/", location.origin);
  target.search = location.search;
  target.hash = location.hash;
  location.replace(target.href);
}
