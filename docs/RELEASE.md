# Release Procedure

Releases are manual and intentional. `Release Candidate` produces hosted
functional evidence and a package candidate, not an npm or GitHub release.
The separate `Publish npm Package` workflow is manual-only and requires
the protected `npm` GitHub Environment, an existing matching version tag, and
an explicit confirmation input.

## 1. Prepare

1. Start from a clean, reviewed commit on the intended release branch.
2. Choose the semantic version and update `package.json`, `package-lock.json`,
   and `CHANGELOG.md` together.
   Before the first tag, keep all entries under `Unreleased`; the tag-triggered
   workflow rejects any `v*` tag that does not exactly equal the package version.
3. Confirm the public API, browser/bundler runtime target, Node development
   toolchain, and Cesium compatibility range.
4. Regenerate `THIRD_PARTY_NOTICES.md` and `docs/sbom.spdx.json` after every
   dependency or lockfile change.
5. Confirm sample-data provenance and that no dataset bytes enter the package.

## 2. Verify

Run from a clean clone with Node 22 and the package-manager version declared in
`package.json`:

```powershell
npm ci
npm run license:evidence:self-test
npm audit
npm run qc:contest-device
npm run evidence:contest:check
npm pack --dry-run
git diff --check
git status --short
```

Preserve the package tarball, checksum, JSON reports, screenshots, and actual
WebGL renderer. Confirm each benchmark's machine-readable `runEvidence` records
the expected UTC, commit SHA, clean/dirty state, source fingerprint, runtime,
and browser version; a dirty candidate must be explained and rerun from the
final clean commit before publication. Confirm the GitHub CI, browser smoke,
Release Candidate functional evidence, and CodeQL runs for that same SHA.
Also confirm `output/package-smoke/browser-result.json` retains the same
validated `runEvidence` together with the exact `releaseCandidateArtifact`
tarball byte length and SHA-256; this is the source-to-candidate identity link.
The contest-device gate must run from a clean worktree and finish with a passing
`output/contest-evidence/contest-evidence-manifest.json`. Its final
`evidence:contest:check` binds the required JSON, screenshots, regression
sessions, exact package tarball, and checksum to the same source state and
rejects any artifact changed after manifest generation.

## 3. Stage a candidate

Trigger `.github/workflows/release-candidate.yml` manually. Its functional-only
`qc:release` omits smoothness because hosted Ubuntu may use SwiftShader. Verify:

- the `.tgz` package candidate;
- the adjacent `.tgz.sha256` checksum generated from that exact candidate;
- functional QC, live Range, renderer, and package-smoke JSON;
- browser smoke screenshots;
- `THIRD_PARTY_NOTICES.md` and `docs/sbom.spdx.json`.

Install that tarball in a fresh consumer; do not rebuild or cite it as
smoothness evidence. Publishing requires the successful same-workflow/SHA run ID.

## 4. Publish

Publishing, tagging, and GitHub release creation require maintainer approval.
Before publishing:

- verify the npm account, organization, package name, access level, and 2FA or
  trusted-publishing configuration;
- verify the tarball SHA-256 and unpacked file list;
- create an annotated Git tag that exactly matches the package version;
- configure the GitHub `npm` Environment with required reviewers;
- configure npm trusted publishing for repository
  `KimDDong03/COPC-Cesium-PointCloud-Provider`, workflow `npm-publish.yml`, and environment `npm`;
- for the first publication only, when trusted publishing cannot yet be bound
  to the new package, place a short-lived granular `NPM_TOKEN` in that protected
  environment and remove it immediately after trusted publishing is enabled;
- manually dispatch `Publish npm Package` on the exact tag, set
  `confirm_publish`, and provide the approved Release Candidate run ID; the
  workflow reruns `npm run qc:release`, downloads the approved same-SHA artifact,
  verifies its checksum, requires the locally reproduced tarball SHA to match,
  and publishes the downloaded approved tarball with npm provenance;
- attach the approved candidate and checksums to the GitHub release;
- verify a clean consumer install from the public registry.

The publish job has `id-token: write` for Sigstore/npm OIDC and never runs on a
push by itself. Prefer trusted publishing over a long-lived token. After the
registry install, run `npm audit signatures` from a clean consumer to verify
registry signatures and provenance attestations. The configuration follows the
current npm guidance for
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance statements](https://docs.npmjs.com/generating-provenance-statements/).

Never force-move a published tag or silently replace release assets. Correct a
bad release with a documented patch version or deprecation notice.

## 5. Post-release

- Confirm README links, security reporting, API docs, declarations, worker
  assets, and Cesium static-asset setup from the installed package. Source maps
  and TypeScript sources are intentionally not part of the current package.
- Record the public npm and GitHub release URLs in `CHANGELOG.md` link
  references.
- Keep the release commit and evidence artifacts reachable for contest review.
- For a competition award, retain the public source repository for the period
  required by the official rules.
