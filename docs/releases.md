# App updates and release verification

Watchtower uses electron-builder 26 and electron-updater 6.8.9 with public
GitHub Releases. Settings > About checks only after a click. Download update
fetches and verifies an artifact; Restart to install closes the worker,
database, harnesses, main runtime, and operational log before starting it.
Closing Watchtower normally does not authorize installation.

On Windows, Restart to install requests a silent NSIS update and relaunch,
including for assisted initial installations. Windows may still request
elevation when required. Initial installation keeps its existing setup wizard.

The About view reads a transient Zustand store. That store owns its explicit
hydration/request state machine and command guards; app-level IPC wiring feeds
it for the lifetime of the app window, including while Settings is closed.
Main-process snapshots carry increasing revisions so late replies and progress
events cannot replace newer state. The main process still owns installation.

Windows NSIS installations and Linux AppImage support in-app updates. Linux
deb installations use a package manager or manual replacement. Development
builds and Windows application directories use the release-page fallback.
macOS builds with ad-hoc signing also use that fallback. The first move from
an old release to an updater-enabled release requires a manual upgrade.
Install the first Developer ID macOS release manually over any ad-hoc build.

## Signing configuration

The repository currently has no signing secrets provisioned. Configuration
alone does not establish that signed artifacts or signed upgrades work.

Configure these GitHub Actions secrets before claiming signed release support:

| Platform | Secrets                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| Windows  | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                                                             |
| macOS    | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

The CSC link is a base64 signing certificate or a supported certificate URL.
The workflow maps platform credentials into electron-builder's `CSC_LINK`
and `CSC_KEY_PASSWORD`. The macOS certificate must be Developer ID Application.
With a certificate configured, `forceCodeSigning` prevents silent unsigned
fallback. macOS also requires notarization credentials, enables hardened
runtime, and notarizes the result. Local packaging uses the same CSC and Apple
environment variables through `electron-builder.config.cjs`.
Blank `CSC_LINK` values from missing CI secrets are removed before packaging
so electron-builder uses the unsigned or ad-hoc fallback instead of importing
an empty certificate path. Empty certificate passwords remain valid.

Without credentials, macOS uses ad-hoc signing, hardened runtime is disabled,
and package metadata disables in-app installation. Keep signing identity
consistent across future releases. Windows unsigned builds retain checksum
verification over HTTPS; configure Windows signing for publisher validation.
Do not disable the updater's signature or checksum checks to bypass failures.

## Publishing

The tag must equal `v` followed by package.json's version. All three packaging
jobs must succeed before publication. They run with `--publish never` and
upload artifacts, `latest*.yml`, and blockmaps to the final release job.
Each packaging job verifies the actual installer artifacts before uploading
them. The final job validates manifest versions, referenced artifacts and
blockmaps, then publishes the complete release. Each format has exactly one
artifact, named `Watchtower-<os>-<arch>.<ext>`. No download copies are created.
The GitHub updater provider resolves filenames under `/releases/download/<tag>/`,
so update URLs remain tied to a version even though filenames stay stable.
This also preserves the README's `/releases/latest/download/` links.
The README's Linux download links use the builder's actual architecture suffixes,
`x86_64` for AppImage and `amd64` for deb.
The first update from the previous versioned naming scheme may use a full
download if the old differential blockmap cannot be found. electron-updater
retains checksum verification for that download.
No publish token or certificate is embedded in the application.

## CI selection

`test.yml` is the only automatic PR workflow. It keeps the required `Lint`
and `Typecheck + tests` check names. Documentation-only changes run formatting;
code and test changes also run typechecks, unit tests and Windows process
regressions. Runtime changes additionally call `e2e.yml` within the same run.

Ordinary runtime changes build and verify Linux and macOS application
directories. Packaging, dependency, build-resource and workflow changes
instead build and verify all installer formats. Installer acceptance already
launches the packaged app, so the directory builds do not run again in that case.
The general Linux/Windows Electron suite retains its existing advisory status.

Protected `main` requires the PR checks, so merging does not start a second
copy of CI. Use `workflow_dispatch` on `test.yml` to run full checks manually,
including after an exceptional direct push. Superseded PR runs are cancelled.
Tags still run core checks on the exact release commit, then build and verify
the artifacts that will be published. Release builds are never replaced with
artifacts from an earlier PR or an unsigned build.

## Required installed upgrade acceptance

Run these checks with disposable installations and isolated user profiles.
Record OS, architecture, source and destination versions, signing identity,
artifact names, and results in the PR or release record. Packaging or mocked
service tests do not substitute for installed upgrade acceptance.

- Install version N and create a ledger and settings changes. Leave an active
  scan or harness operation running before requesting the upgrade.
- Publish N+1 and check from N. Confirm no download occurs until requested,
  progress appears, and the ready state does not install on normal quit.
- Relaunch, check and download again, then choose Restart to install. Confirm
  child processes close, N+1 launches, and the ledger and settings remain.
- Exercise offline checks, a failed or interrupted download, retry, and a
  deliberately mismatched checksum. Failed verification must never install.
- Verify Windows NSIS and Linux AppImage updates. Verify deb and unpacked
  directory fallbacks. On macOS, test the manual ad-hoc-to-Developer-ID
  migration, then N-to-N+1 with the same Developer ID on Intel and Apple Silicon.
- For assisted Windows installations, confirm the update applies without
  reopening the setup wizard and relaunches the app in its existing installation
  directory. Verify per-user installs and per-machine installs requiring elevation.
- Verify Windows publisher signatures and macOS code signatures, notarization,
  and launch behavior with Gatekeeper enabled.

Installed N-to-N+1 acceptance and signed macOS migration remain open until
executed with release artifacts and the required credentials.
