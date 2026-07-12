# Changesets

This workspace uses [Changesets](https://github.com/changesets/changesets) for independent package
versions, changelogs, npm publication, and GitHub releases.

Run `pnpm changeset`, select the affected packages and bump levels, then commit the generated
Markdown file with the implementation. Merges to `main` update a `chore: version packages` pull
request. Merging that pull request publishes the packages and creates GitHub releases.
