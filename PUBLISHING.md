# Publishing

Publishing is manual. CI validates source, integration tests, and browser packages; it never
downloads or executes an update. Keep Stable and Prerelease as separate release channels.

## Build and verify

```powershell
.\scripts\validate.ps1
node --test tests\*.test.js
.\scripts\build-release.ps1 -Version 1.6.0
```

Verify `SHA256SUMS.txt`, both artifact manifests, and the Store ZIP root layout. Test capture,
browser-local fallback, pairing, SQLite, sync, and uninstall before uploading.
The release-policy verifier interface is:

```text
node scripts/verify-release-artifacts.js <artifact-directory> <version-without-v> <true|false>
```

The last argument is the prerelease boolean (`true` for `1.6.0-beta.1`, `false` for `1.6.0`);
it is not a channel name or version. On Ubuntu, also run `sha256sum -c SHA256SUMS.txt`.
Unsigned desktop files are explicitly named `*-Windows-unsigned.zip` and `*-unsigned.dmg`;
signed Windows files use `*-Windows-signed.zip`.
Prerelease/build metadata belongs in the artifact version (for example
`1.6.0-beta.1+build.7`); the Chrome manifest remains the matching numeric core (`1.6.0`).
Packaged Windows/standalone extensions record that full identity in `release-info.js`, so update
comparison and the library UI do not mistake a prerelease for the stable manifest core. Store
packages intentionally record the numeric manifest version.

## Edge Add-ons

1. Sign in to Partner Center, choose **Microsoft Edge > Extensions > New extension**, and reserve
   **AI Knowledge Inbox**.
2. Upload `AI-Knowledge-Inbox-Store-<version>.zip`.
3. Copy descriptions from `store-assets/edge-listing.md`, privacy text from `PRIVACY.txt`, and
   permission explanations from `PERMISSIONS.md`.
4. Upload the 128 px icon and the three reviewed screenshots; complete every item in
   `LISTING-CHECKLIST.md`.
5. Declare no ads, analytics, remote code, or sale of data. Explain that GitHub is contacted only
   after **Check updates** is clicked.
6. Submit to the Prerelease audience first; after approval and smoke testing, promote the same
   validated ZIP to Stable.

## Chrome Web Store

1. In the Developer Dashboard choose **New item** and upload the same Store ZIP.
2. Complete Store listing, Privacy practices, Distribution, and Test instructions using the
   files under `store-assets/`.
3. Explain `activeTab`, `contextMenus`, `scripting`, `storage`, both localhost origins, and the
   manual GitHub releases request.
4. Use staged publishing, test the approved item, then publish. Keep the previous approved ZIP
   and item version for rollback evidence.

## Windows signing

Use a publicly trusted Authenticode code-signing certificate with private key and timestamping.
Never store the PFX or password in the repository.

```powershell
# Certificate already in CurrentUser\My
.\scripts\build-release.ps1 -Version 1.6.0 -Sign -CertificateThumbprint <thumbprint>

# Explicit PFX input (prefer a CI secret for the password)
.\scripts\build-release.ps1 -Version 1.6.0 -Sign -PfxPath <file.pfx> -PfxPassword $env:WINDOWS_PFX_PASSWORD
```

The build fails closed for missing/invalid credentials or signatures. Stable packages contain no
`.cmd` launchers: run the Authenticode-signed `install.ps1` with `ExecutionPolicy AllSigned`.
The installer, uninstaller, and desktop companion PowerShell scripts are signed and verified.
`server.js`, Node, and extension files are not claimed as Authenticode-signed; their hashes are
covered by `payload-manifest.json`, whose hash is embedded in the signed installer. The installer
rejects missing, extra, size-mismatched, or hash-mismatched payload files before copying or running
them. The portable installer remains supported; see `docs/DISTRIBUTION_DECISION.md`.

## Apple Developer ID and notarization

Import a **Developer ID Application** identity into the build keychain. For signed-only builds set
`APPLE_SIGN_IDENTITY`. For notarization also set `APPLE_NOTARIZE=1` and one complete credential set:

- App Store Connect key: `APPLE_NOTARY_KEY` (path), `APPLE_NOTARY_KEY_ID`,
  `APPLE_NOTARY_ISSUER_ID`; or
- Apple ID: `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` (app-specific password).

```bash
APPLE_SIGN_IDENTITY="Developer ID Application: …" APPLE_NOTARIZE=1 \
  bash scripts/build-macos.sh 1.6.0
```

The script signs the bundled Node runtime with the required JIT/runtime entitlements from
`macos/node-entitlements.plist`, then signs the app and DMG, submits with `notarytool`, staples,
and validates. Notarization fails closed when credentials are incomplete. Without these variables
it creates clearly named `*-unsigned.dmg` files and smoke-tests the ad-hoc-signed Node runtime.

## GitHub release channels and rollback

- Tags such as `v1.7.0-beta.1` are Prerelease; stable tags have no prerelease suffix.
- Current Beta desktop packages are unsigned. Prerelease tags intentionally publish unsigned
  Windows/macOS desktop artifacts and set GitHub `prerelease=true`.
- Stable tags fail closed unless all protected repository secrets below are present and valid:
  - `WINDOWS_CERTIFICATE_PFX_BASE64`: base64-encoded trusted Authenticode PFX.
  - `WINDOWS_PFX_PASSWORD`: PFX import password.
  - `APPLE_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application certificate.
  - `APPLE_CERTIFICATE_PASSWORD`: P12 import password.
  - `APPLE_SIGN_IDENTITY`: exact Developer ID Application identity.
  - `APPLE_NOTARY_KEY_BASE64`: base64-encoded App Store Connect `.p8` key.
  - `APPLE_NOTARY_KEY_ID` and `APPLE_NOTARY_ISSUER_ID`: notarization API identifiers.
- Add these in **Settings → Secrets and variables → Actions** as environment/repository secrets
  protected to release maintainers. The workflow masks passwords, writes credentials only under
  the runner temporary directory, uses a temporary keychain, and removes all material afterward.
- Stable publishing verifies `signed=true` for Windows and `signed=true`, `notarized=true` for
  macOS before creating the GitHub release. It also recomputes every artifact size/SHA-256,
  validates `SHA256SUMS.txt`, and rejects unexpected release files.
- Publish release notes, checksums, artifact manifests, Windows ZIP, both macOS DMGs, Extension ZIP,
  and Store ZIP. Do not move an existing tag.
- To roll back desktop, mark the faulty release unavailable, restore the prior release link, and
  publish a higher patch version with the fix; never replace artifacts under an existing version.
- To roll back stores, use each store's staged/rollback control where available, or submit a higher
  patch version built from the prior source. Disable the listing only for urgent security issues.
- Update checks only show a release URL; they never auto-download or execute it.
