# Releasing SessionFlow for macOS arm64

This repository publishes to [zlsbksdxl/SessionFlow Releases](https://github.com/zlsbksdxl/SessionFlow/releases).
The public product name is `SessionFlow`. The internal app identifier
`com.observedobserver.looperators`, existing Orrery/orrery namespaces, and
storage paths are preserved for compatibility with saved sessions and settings.
Version `0.2.0` is this repository's initial release under the previous brand;
`0.2.1` is the first SessionFlow release. The higher version lets installed
`0.2.0` builds discover the branded update. The packaged update feed must use
owner `zlsbksdxl` and repository `SessionFlow`.

All installer output goes to `outputs/release/`. Every release includes:

- `SessionFlow-<version>-mac-arm64.dmg`
- `SessionFlow-<version>-mac-arm64.zip`
- the matching `.dmg.blockmap` and `.zip.blockmap`
- `latest-mac.yml`
- `SHA256SUMS`, covering the five files above

## Stable automatic-update releases

Stable releases used by the automatic updater must be Developer ID signed and
Apple notarized. The workflow defaults to **signed** and fails when signing
credentials, the expected Team ID, or notarization checks are missing or fail.
It never falls back to an ad-hoc build. Keep the existing bundle identifier,
signing team, and native code-signing requirement compatible between releases.
The updater needs the ZIP and `latest-mac.yml`; retain the DMG, blockmaps, and
checksums as well.

The Update button beside Settings downloads the update, then waits for running
tasks to become idle and saves application state before asking the native
macOS updater to install and restart. Downloading does not terminate running
tasks. Do not replace this with an installer script, weaken signature
validation, or describe a successful download as a successful installation.

### One-time migration from the existing ad-hoc builds

The currently published `v0.3.0` is ad-hoc signed without Developer ID signing
or Apple notarization. It predates the stable-feed policy above. Its macOS
designated requirement identifies that exact build by code hash; a different
build cannot satisfy it. Squirrel.Mac checks an update against the running
app's designated requirement. Consequently, an existing ad-hoc installation
cannot automatically migrate to the first Developer ID signed release.

Users must manually install that first signed release once, using its DMG or
ZIP from GitHub. Later compatible signed releases can use the Update button.
Keep application storage identity unchanged so this manual replacement retains
saved chats and settings. Keep the old release, tag, and assets as historical
records; do not rewrite them to claim a different signature. Until the first
signed stable release is published, GitHub's latest release may still point at
the historical ad-hoc `v0.3.0`; that does not establish automatic-installation
support.

See the [Electron autoUpdater documentation](https://www.electronjs.org/docs/latest/api/auto-updater)
and [Squirrel.Mac code-signature verification](https://github.com/Squirrel/Squirrel.Mac/blob/main/Squirrel/SQRLCodeSignature.m).

## Manual-install ad-hoc prerelease without Apple credentials

Use the explicit ad-hoc build on an Apple Silicon Mac with Node.js 24:

```sh
npm ci
npm run test:ci
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac:adhoc
```

The ad-hoc script sets `mac.identity=-`, disables hardened runtime for that
build, and disables notarization. Setting `CSC_IDENTITY_AUTO_DISCOVERY=false`
alone does not request an ad-hoc signature. These artifacts have an ad-hoc
signature for code integrity, but have **no Developer ID signing or Apple
notarization**. macOS Gatekeeper may block their first launch. Public release
notes must state that limitation; do not describe this mode as notarized or as
Developer ID signed.

New ad-hoc builds are **manual-install-only prereleases**. Publish them with
GitHub's prerelease flag and `--latest=false`, even when the version tag uses
`X.Y.Z`. They must not replace a signed stable release or its update feed.
The application's stable updater excludes prereleases.

### Installing the first macOS build

The download supports Apple Silicon (arm64) and macOS 12 or later. Open the
DMG and drag `SessionFlow.app` into Applications; the ZIP is an alternative.
For this unnotarized build, macOS may show a developer-verification warning.
Review [Apple's official instructions](https://support.apple.com/102445) if
you choose to allow this application in System Settings > Privacy & Security.
The selected Claude Code, Codex, or Grok CLI must still be installed and
authenticated separately; the installer does not include provider credentials.

Before publishing, verify the built app and both archives, including a local
launch of the packaged app. Check the app version and arm64 architecture,
`codesign --verify --deep --strict`, its ad-hoc signature, and the packaged
`Contents/Resources/app-update.yml` owner/repository. Generate and verify the
manifest from inside the output directory:

```sh
cd outputs/release
shasum -a 256 SessionFlow-0.3.1-mac-arm64.dmg SessionFlow-0.3.1-mac-arm64.zip \
  SessionFlow-0.3.1-mac-arm64.dmg.blockmap SessionFlow-0.3.1-mac-arm64.zip.blockmap \
  latest-mac.yml > SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

When publishing locally, create a draft for the exact verified commit, upload
all six files, and read back the assets and release notes. For an ad-hoc build,
create that draft with `--prerelease --latest=false`, then publish it using
`gh release edit <tag> --draft=false --prerelease --latest=false`.
Keep the public note: **Ad-hoc signed; no Developer ID signing or Apple
notarization. Manual installation only; excluded from stable automatic
updates.** Use a fresh version tag; never replace the existing `v0.3.0` assets.

### Versioned branding transition

Publish the SessionFlow build as a new `v0.2.1` release with the display title
exactly **SessionFlow 0.2.1**. Keep the public `v0.2.0` tag and original assets
as historical release data; do not move or force-push that tag, or replace its
assets. Its display title is **SessionFlow 0.2.0**. Architecture and platform
information belongs in release notes and filenames, without a title suffix.
The workflow below creates new releases and refuses to overwrite an existing
release. Internal app identifiers and storage paths remain unchanged across
the branding transition to preserve saved sessions and settings.

## Manual GitHub Actions release

The `Release SessionFlow macOS arm64` workflow uses **workflow_dispatch only**.
Creating a local release or pushing its tag does not start a second publisher.
Choose either local publishing or the workflow for a version.

In the repository's Actions tab, choose the intended commit/ref, enter the
fresh version, and keep **signed** checked for a stable automatic-update
release. Configure the Apple credentials below first. Explicitly unchecking
**signed** selects the ad-hoc, unnotarized path and needs no Apple secrets;
that path publishes a manual-install-only prerelease with `--latest=false`.
The workflow runs deterministic checks, builds the app, verifies its
identity/signature/architecture/update feed, and checks all required assets.
It uploads to a draft and verifies the six remote asset names and sizes before
publishing that draft. Only the signed path marks its release as latest.
Its `gh release create` command fails if that release already exists, including
an existing draft; it does not replace a local publication. If the tag already
exists, it must point to the selected workflow commit. Otherwise GitHub creates
the version tag at that exact commit when publishing.

## Developer ID signed and notarized release

Before using the default **signed** path, configure all five Actions secrets:

- `CSC_LINK`: base64-encoded Developer ID Application `.p12`
- `CSC_KEY_PASSWORD`: the `.p12` export password
- `APPLE_API_KEY`: raw App Store Connect API `.p8` contents
- `APPLE_API_KEY_ID`: the API key ID
- `APPLE_API_ISSUER`: the issuer ID

Also configure the repository variable `APPLE_TEAM_ID` with the certificate's
10-character Team ID. This is your signing team; the workflow does not assume
the upstream project's team. No Apple credentials are loaded for an explicit
ad-hoc run.

The signed path rejects missing credentials, requires code signing, uses the
distribution certificate type and hardened runtime, and enables the installed
electron-builder notarization integration. After building it requires a valid
Developer ID signature from the configured team, a successful Gatekeeper
assessment, and a valid stapled notarization ticket before publishing. A
signing/notarization failure never falls back to an ad-hoc release.

For a local signed build, first configure `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY` (an absolute path to the `.p8` file locally), `APPLE_API_KEY_ID`,
and `APPLE_API_ISSUER` in the packaging environment, then run:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=true npm run dist:mac -- \
  -c.forceCodeSigning=true -c.mac.type=distribution \
  -c.mac.hardenedRuntime=true -c.mac.notarize=true
```

Apply the same Developer ID, Team ID, `spctl`, and `xcrun stapler validate`
checks locally. A successful packaging command by itself is not proof of
notarization. Keep signing credentials out of the repository and release
assets.

Development builds disable update checks. Test the configured feed from the
packaged app. State-machine or mocked-downloader checks can verify prompts,
progress, retries, idle waiting, and save-before-install ordering; they do not
verify native installation. A real end-to-end installation check requires two
different compatible Developer ID signed builds, a higher update version, and
an isolated installed app and data directory. Verify the relaunched version
and saved data after installation. An ad-hoc build can establish feed
reachability and version detection, but cannot prove this signed installation
path. Publishing a release or a passing packaging command alone is not an
installation test.
