# Security Policy

## Supported version

Security fixes are provided for the latest Beta release.

## Reporting

Do not open a public issue for a vulnerability that exposes private knowledge or permits code execution. Use GitHub's private vulnerability reporting feature for this repository.

Include:

- Affected version
- Reproduction steps using non-sensitive sample data
- Expected impact
- Suggested mitigation, if known

## Security boundaries

- The local service binds only to `127.0.0.1`.
- Browser requests are restricted to extension origins.
- Sensitive local API routes require a timing-safe-verified, random per-install bearer token.
- Before sending that bearer token or any sensitive request body, clients send a fresh random nonce to the unauthenticated, rate-limited `/auth/challenge` endpoint. The genuine service returns only an HMAC-SHA256 proof over the fixed `AIKnowledgeInbox.LocalAPI.AuthChallenge` domain, protocol version, and exact nonce. Clients verify it with their stored token and cache success for at most 15 seconds. Invalid proofs are treated as a security error, not an offline fallback.
- Extension provisioning requires a user-visible, short-lived, one-time pairing code with expiry, attempt bounds, and rate limiting; successfully paired extension origins are remembered.
- Pairing remains user-mediated: the code is shown only by the installed companion after the companion has verified the service using its local token file. Arbitrary pages cannot call the exchange, and an arbitrary extension still needs the exact expiring code. The extension verifies the returned token with a fresh challenge before migrating or sending knowledge.
- Normal web origins are rejected even if they can reach loopback. Unauthenticated `/health` returns only minimal availability.
- Diagnostics are authenticated and exclude knowledge fields, source URLs, operation payloads, and secrets; home-directory portions of paths are redacted.
- Markdown is rendered with DOM APIs rather than `innerHTML`.
- Knowledge supplied to built-in AI is marked as untrusted source data.
- Release builds are accompanied by SHA-256 checksums.
