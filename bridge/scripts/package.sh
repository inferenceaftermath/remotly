#!/usr/bin/env bash
# Build what install.sh downloads: dist/remotly-bridge-<version>.tar.gz (sources + production node_modules, all pure
# JS, so one tarball serves every Linux architecture), SHA256SUMS and a copy of install.sh. Run by release.yml.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ver="$(node -p "require('$here/package.json').version")"
name="remotly-bridge-$ver"
dist="$here/dist"; stage="$dist/$name"
rm -rf "$dist"; mkdir -p "$stage"
cp -R "$here/package.json" "$here/package-lock.json" "$here/README.md" "$here/bin" "$here/src" "$stage/"
# The licence and the attribution notice travel with every distributed copy (Apache-2.0 §4).
cp "$here/../LICENSE" "$here/../NOTICE" "$stage/"
(cd "$stage" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts --silent)
# Reproducible enough to diff two builds of one commit: sorted entries, neutral owner, commit time, no gzip name/time.
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$here" log -1 --format=%ct 2>/dev/null || date +%s)}"
tar -C "$dist" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" -cf - "$name" | gzip -n -9 > "$dist/$name.tar.gz"
rm -rf "$stage"
cp "$here/../install.sh" "$dist/install.sh"
(cd "$dist" && sha256sum "$name.tar.gz" install.sh > SHA256SUMS)
for f in LICENSE NOTICE src/main.ts src/setup.ts; do
  tar -tzf "$dist/$name.tar.gz" "$name/$f" >/dev/null 2>&1 || { echo "package.sh: $f missing from $name.tar.gz" >&2; exit 1; }
done
ls -la "$dist"
