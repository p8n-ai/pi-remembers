# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainer directly or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)

## Security Considerations

### API Token

The extension authenticates with the Cloudflare AI Search REST API using a standard API Token. This token:

- Should be stored as an environment variable (e.g., `CLOUDFLARE_API_TOKEN`)
- Should be referenced in `~/.pi/pi-remembers.json` by env var name, not as a literal value
- Is resolved from `process.env` at runtime by the extension
- Requires only `AI Search:Edit` and `AI Search:Run` permissions — no broader access needed

### Data Privacy

- **Memories** are stored in your own Cloudflare account's AI Search instances
- **No data** is sent to third parties — everything stays within your Cloudflare account
- **Direct API** — the extension calls the Cloudflare API directly, no proxy in between
- **Project files** indexed via `/memory-index` are uploaded to your AI Search instance
- The extension does **not** phone home or collect telemetry

### Secrets in Config Files

- `~/.pi/pi-remembers.json` should reference env var names, not literal tokens
- `.pi/pi-remembers.json` (project config) contains no secrets — only instance names and toggles
- Both config paths are in `.gitignore` as a safety net

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | ✅ Current          |
