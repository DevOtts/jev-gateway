# Releasing

Pushing a tag publishes it. There is no npm token and no one-time password involved: npm trusts
this repository's `release.yml` workflow directly (trusted publishing, OIDC).

## Cutting a release

1. Set the new version in `package.json` and add its section to `CHANGELOG.md` (a `## X.Y.Z`
   heading; the section becomes the GitHub release notes).
2. Commit to `main`.
3. Tag and push:

   ```bash
   git tag v0.3.1
   git push origin main v0.3.1
   ```

`release.yml` then checks that the tag matches `package.json` and sits on `main`, runs the type
check, the tests and the build, publishes to npm with provenance, creates the GitHub release from
the changelog, and calls the Homebrew workflow (which does nothing until a tap is set up, see
[homebrew-tap.md](homebrew-tap.md)). Every step can be re-run: a version that is already on npm
and a release that already exists are skipped.

To try everything short of publishing, or to release a tag that already exists:

```bash
gh workflow run release.yml -f tag=v0.3.1 -f dry_run=true
gh workflow run release.yml -f tag=v0.3.1
```

## One-time setup on npmjs.com

Trusted publishing is switched on per package, by an owner, in the browser:

1. Open https://www.npmjs.com/package/jev-gateway/access and find **Trusted Publisher**.
2. Choose **GitHub Actions** and fill in:

   | Field | Value |
   | --- | --- |
   | Organization or user | `vinilana` |
   | Repository | `jev-gateway` |
   | Workflow filename | `release.yml` |
   | Environment name | leave empty |

3. Save. Then, on the same page under **Publishing access**, pick **Require two-factor
   authentication and disallow tokens**. After that the workflow is the only thing that can
   publish, and a leaked token is worth nothing.

npm matches the repository and the workflow file name exactly. Renaming `release.yml`, or moving
the `npm publish` step into a reusable workflow, breaks publishing until the setting is updated.

## Why it is built this way

- **No secrets to leak.** GitHub hands the job a short-lived identity token (`id-token: write`)
  and npm exchanges it for a one-off publish credential. Nothing long-lived exists to steal.
- **Provenance for free.** Packages published this way carry a signed statement of which commit
  and which workflow run built them, shown on the npm page.
- **Scripts stay out of the publish step.** The checks and the build run first, and the publish
  itself uses `--ignore-scripts`, so no package script runs while the job holds the identity.
- **Actions are pinned to commit hashes**, so a moved tag in someone else's action cannot change
  what runs here.
- **Only tags on `main` publish.** A tag pushed from another branch is refused.
