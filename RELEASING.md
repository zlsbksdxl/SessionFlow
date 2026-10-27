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

## Ad-hoc release without Apple credentials

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
shasum -a 256 SessionFlow-0.3.0-mac-arm64.dmg SessionFlow-0.3.0-mac-arm64.zip \
  SessionFlow-0.3.0-mac-arm64.dmg.blockmap SessionFlow-0.3.0-mac-arm64.zip.blockmap \
  latest-mac.yml > SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

When publishing locally, create a draft for the exact verified commit, upload
all six files, read back the assets and release notes, then publish the draft.
Keep the public note: **Ad-hoc signed; no Developer ID signing or Apple
notarization.** Use a stable version tag such as `v0.3.0`.

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
stable version, and leave **signed** unchecked for the explicit ad-hoc,
unnotarized path. It needs no Apple secrets. The workflow runs deterministic
checks, builds the app, verifies its identity/signature/architecture/update
feed, checks all required assets, and publishes with the unnotarized notice.
It uploads to a draft and verifies the six remote asset names and sizes before
publishing that draft.
Its `gh release create` command fails if that release already exists, including
an existing draft; it does not replace a local publication. If the tag already
exists, it must point to the selected workflow commit. Otherwise GitHub creates
the version tag at that exact commit when publishing.

## Optional Developer ID signed and notarized release

Select **signed** only after configuring all five Actions secrets:

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
packaged app; a first release can establish feed reachability, while a later
higher version is needed to verify that an update is offered.
