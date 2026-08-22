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
- Markdown is rendered with DOM APIs rather than `innerHTML`.
- Knowledge supplied to built-in AI is marked as untrusted source data.
- Release builds are accompanied by SHA-256 checksums.
