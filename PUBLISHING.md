# Publishing

## Recommended channel combination

1. **GitHub repository** — public source, issues, privacy/security policies, and documentation.
2. **GitHub Releases** — Windows all-in-one ZIP, standalone browser extension ZIP, and SHA-256 checksums.
3. **GitHub Pages** — product overview and stable download entry point.
4. **Microsoft Edge Add-ons** — recommended first browser store because the product targets Copilot and Microsoft users.
5. **Chrome Web Store** — submit after Edge feedback confirms permission explanations and onboarding.

The Windows companion should remain on GitHub Releases until it is code-signed. Store submission materials are under `store-assets/`.

## Repository settings

- Owner: `lindaf0617-hub`
- Repository: `ai-knowledge-inbox`
- Visibility: Public
- Default branch: `main`
- Description: `Private local-first knowledge inbox for AI outputs, with cited Ask and OneDrive sync.`
- Suggested topics: `ai`, `knowledge-base`, `browser-extension`, `onedrive`, `rag`, `local-first`, `copilot`

Enable:

- Issues
- Discussions
- Private vulnerability reporting
- GitHub Pages through GitHub Actions

## First release

1. Push the `main` branch.
2. Confirm the Validate and Pages workflows pass.
3. Create and push tag `v1.6.0`.
4. The Release workflow builds and attaches:
   - `AI-Knowledge-Inbox-1.6.0-Windows.zip`
   - `AI-Knowledge-Inbox-1.6.0-macOS-unsigned.dmg`
   - `AI-Knowledge-Inbox-Extension-1.6.0.zip`
   - `SHA256SUMS.txt`
5. Mark the GitHub Release as **pre-release** while Beta testing continues.

## Before broad public distribution

- Obtain Windows code-signing credentials.
- Replace unpacked-extension installation with Edge/Chrome store listings.
- Add a macOS desktop companion or explicitly keep desktop support Windows-only.
- Validate OneDrive conflicts with multiple real devices.
- Add an automatic desktop updater only after signed installers are available.
