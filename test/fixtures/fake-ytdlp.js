const args = process.argv.slice(2);
const expectedSource = "https://soundcloud.com/dj/set";

if (
  args[0] !== "inspect" ||
  args[1] !== expectedSource ||
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
        webpage_url: expectedSource,
        uploader: "DJ",
        extractor_key: "Soundcloud",
      },
    },
  }),
);
