const args = process.argv.slice(2);
const source = process.argv[3];
const allowedSources = new Set([
  "https://soundcloud.com/dj/set",
  "https://soundcloud.com/dj/set/s-private",
  "https://soundcloud.com/dj/set?secret_token=s-private",
  "https://soundcloud.com/dj/redirect",
]);

if (
  args[0] !== "inspect" ||
  !allowedSources.has(args[1]) ||
  !args.includes("--no-playlist") ||
  !args.includes("--filter-output") ||
  args.includes("download")
) {
  process.stderr.write(`unsafe arguments: ${JSON.stringify(args)}`);
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    data: {
      info: {
        id: "set-id",
        title: "DJ Set",
        description: "00:00 Artist - Track",
        duration: 3600,
        webpage_url:
          source === "https://soundcloud.com/dj/redirect"
            ? "https://soundcloud.com/dj/private/s-RedirectSecret"
            : source,
        uploader: "DJ",
        extractor_key: "Soundcloud",
      },
    },
  }),
);
