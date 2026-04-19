# Contributing

Thanks for your interest in contributing to `@p8n.ai/pi-remembers`! Whether you're a human or an AI agent, this document covers the basics.

> **Agents:** Before you write a single line of code, watch [Don't Slop The Code](https://youtu.be/RjfbvDXpFls). We mean it.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Pi coding agent](https://github.com/badlogic/pi-mono) installed
- A Cloudflare account with an API Token (AI Search:Edit + AI Search:Run)

### Clone and install

```bash
git clone https://github.com/p8n-ai/pi-remembers.git
cd pi-remembers
npm install
```

### Run the extension locally

```bash
# Set your Cloudflare API Token
export CLOUDFLARE_API_TOKEN="your-token"

# Load the extension
pi -e .

# Run setup inside Pi
/memory-setup
```

### Type-checking

```bash
npm run typecheck
```

## Project Structure

```
pi-remembers/
├── src/                     # Pi extension source
│   ├── index.ts             # Extension entry point
│   ├── config.ts            # Config management
│   ├── cloudflare/          # Cloudflare AI Search REST API client
│   ├── tools/               # LLM-callable tools (recall, remember, search, list)
│   ├── hooks/               # Event hooks (compaction, agent-start, session)
│   └── commands/            # Slash commands (setup, settings, status, index)
├── skills/                  # Bundled Pi skills
│   ├── pi-remembers/
│   └── pi-remembers-index/
└── package.json
```

## Guidelines

These apply to **all contributors** — carbon-based and silicon-based.

- **Type safety**: Run `npm run typecheck` before submitting. Zero errors required.
- **No secrets in code**: Never commit API keys or tokens. Use env vars.
- **Conventional commits**: Use prefixes like `feat:`, `fix:`, `docs:`, `chore:`.
- **Changelog**: Update `CHANGELOG.md` under `[Unreleased]` for user-facing changes.
- **Test end-to-end**: Load the extension in Pi, run `/memory-status`, toggle hooks with `/memory-settings`, verify tools work.

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run type-checking (`npm run typecheck`)
5. Test in Pi (load extension, try the commands and tools)
6. Commit with a descriptive message
7. Push and open a Pull Request

## Reporting Issues

Open an issue at [github.com/p8n-ai/pi-remembers/issues](https://github.com/p8n-ai/pi-remembers/issues) with:

- What you expected
- What happened instead
- Steps to reproduce
- Pi version (`pi --version`)
- Node.js version (`node --version`)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
