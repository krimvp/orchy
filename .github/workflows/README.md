# CI and publishing

Two workflows live here.

## `ci.yml` — every push to `main` and every pull request

Runs `npm ci`, then the tests, the compiler, and the UI build. This is the gate
that keeps `main` green. Nothing publishes from here.

## `publish.yml` — publishes to npm

It starts when you **publish a GitHub Release**, or by hand from the **Actions**
tab. GitHub drives the whole of it, and the release **tag is the version**: the
workflow reads the version from the tag, runs the tests and the compiler, stamps
`package.json` with that version inside the runner, builds the UI, and runs
`npm publish --provenance --access public`. You never run `npm version` or
`npm publish` yourself.

Then the `sync-version` job opens a PR that brings `package.json` on `main` to
the version that went out, and turns on auto-merge, so the repository's version
catches up to npm by itself. See [Version sync](#version-sync).

The package is `@krimvp/orchy`, because the bare name `orchy` belongs to another
account. The command it installs is still `orchy`.

### One-time setup

1. **`NPM_TOKEN` — the right to publish.** On <https://www.npmjs.com> →
   *Access Tokens* → *Generate New Token* → **Automation** (or a *Granular*
   token that may publish `@krimvp/orchy`). Add it under the GitHub repository →
   *Settings* → *Secrets and variables* → *Actions* → *New repository secret*,
   named **`NPM_TOKEN`**.
2. **`RELEASE_TOKEN` — the token that opens the version-sync PR.** A
   [fine-grained PAT](https://github.com/settings/tokens?type=beta) scoped to
   **this repository alone**, with **Contents: Read and write** and **Pull
   requests: Read and write**. Add it as a second repository secret named
   **`RELEASE_TOKEN`**. It has to be a PAT rather than the built-in
   `GITHUB_TOKEN`, so the sync PR runs CI — see [Version sync](#version-sync).
   Without this secret a release still publishes, and only the sync PR is
   skipped.
3. Turn on *Settings → General → Allow auto-merge*, so the sync PR merges itself
   once CI is green.
4. The first publish of a scoped package needs the scope to exist. `npm publish`
   creates `@krimvp` on the first run under an account named `krimvp`; the
   `--access public` flag in the workflow keeps the package public, because a
   scoped package is private by default.

### Cutting a release

Releasing is one action — create a GitHub Release. Actions does the rest.

- **GitHub UI:** *Releases* → *Draft a new release* → *Choose a tag* → type a new
  `vX.Y.Z` → *Publish release*.
- **CLI:** `gh release create vX.Y.Z --target main --generate-notes --title vX.Y.Z`
- **Actions tab:** *Publish to npm* → *Run workflow*, with the version written
  out.

Before you do, move the lines under `## [Unreleased]` in `CHANGELOG.md` to a
`## [X.Y.Z] - YYYY-MM-DD` heading and merge that. The workflow refuses to
publish a version that the changelog does not name, so a release always carries
notes.

> The tag says which version goes out. The workflow stamps `package.json` to
> match at publish time, so no bump comes first.
>
> A publish that fails is fixed forward: release the **next** version. A version
> on npm cannot be replaced.

### Version sync

After the publish, the `sync-version` job checks out `main`, bumps
`package.json` on a `chore/sync-version-X.Y.Z` branch, opens a PR, and turns on
auto-merge — so the bump merges itself once CI is green. It does nothing when
`package.json` already stands at that version.

Why a PAT and not the built-in `GITHUB_TOKEN`? GitHub deliberately runs no
workflow for an event that `GITHUB_TOKEN` caused, so a PR it opened would never
get the checks it needs and would sit there unmergeable. A PAT acts as you, so
the PR runs CI as any other.

### What the tarball holds

`files` in `package.json` names `dist` and `ui/dist`, and git carries neither.
The `prepack` script builds both before `npm pack` and `npm publish`, by hand as
well as in CI, so a tarball cannot go out half-built. Run `npm pack --dry-run`
to read the list of files before a release.

`dist` holds the compiled source. A clone runs the TypeScript as it stands,
because Node strips the types, but Node refuses to strip the types of a file
under `node_modules` — an installed package that shipped `.ts` would fail with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on the first command. So
`npm run build` compiles `src` to `dist` through `tsconfig.build.json`, which
turns the `.ts` in every import into `.js` on the way out, and `bin`, `exports`,
and `types` all point into `dist`.

`ui/dist` holds the page the daemon serves.

### Provenance

The publish uses [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which needs the `id-token: write` permission — already set — and a public
repository. It attaches a signed link from the tarball on npm back to the run
that built it. Nothing else to set up.
