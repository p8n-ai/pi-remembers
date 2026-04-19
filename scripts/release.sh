#!/usr/bin/env bash
set -euo pipefail

# Release script for @p8n.ai/pi-remembers
#
# Usage:
#   ./scripts/release.sh patch    # 0.1.0 → 0.1.1
#   ./scripts/release.sh minor    # 0.1.0 → 0.2.0
#   ./scripts/release.sh major    # 0.1.0 → 1.0.0
#   ./scripts/release.sh 0.2.0    # explicit version
#
# What it does:
#   1. Bumps version in package.json (no git tag — CI handles that)
#   2. Moves [Unreleased] content in CHANGELOG.md to a new version section
#   3. Creates a release commit
#   4. Prints next steps

BUMP="${1:?Usage: ./scripts/release.sh <patch|minor|major|x.y.z>}"

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Type-check
echo "Running typecheck..."
npm run typecheck

# Bump version
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
  npm version "$BUMP" --no-git-tag-version
else
  NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
fi

echo "Version: $NEW_VERSION"

# Update CHANGELOG: move [Unreleased] → [x.y.z] - date
DATE=$(date +%Y-%m-%d)
PREV_VERSION=$(git tag --sort=-version:refname | head -1 | tr -d 'v')

# Create the new version header and update links
if [ -z "$PREV_VERSION" ]; then
  # First release — no comparison link for 0.1.0
  sed -i '' \
    -e "s/^## \[Unreleased\]/## [Unreleased]\n\n## [$NEW_VERSION] - $DATE/" \
    -e "s|^\[Unreleased\]:.*|[Unreleased]: https://github.com/p8n-ai/pi-remembers/compare/v$NEW_VERSION...HEAD\n[$NEW_VERSION]: https://github.com/p8n-ai/pi-remembers/releases/tag/v$NEW_VERSION|" \
    CHANGELOG.md
else
  sed -i '' \
    -e "s/^## \[Unreleased\]/## [Unreleased]\n\n## [$NEW_VERSION] - $DATE/" \
    -e "s|^\[Unreleased\]:.*|[Unreleased]: https://github.com/p8n-ai/pi-remembers/compare/v$NEW_VERSION...HEAD\n[$NEW_VERSION]: https://github.com/p8n-ai/pi-remembers/compare/v$PREV_VERSION...v$NEW_VERSION|" \
    CHANGELOG.md
fi

# Commit
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v$NEW_VERSION"

echo ""
echo "✓ Release v$NEW_VERSION prepared"
echo ""
echo "Next steps:"
echo "  1. Review: git log -1 --stat"
echo "  2. Push:   git push origin main"
echo "  3. CI will: typecheck → npm publish → GitHub Release"
