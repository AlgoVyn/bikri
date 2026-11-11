#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

version="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo 0.1.1)}"
mkdir -p dist
rm -rf dist/windows-amd64 dist/linux-amd64 dist/linux-arm64 \
  dist/darwin-amd64 dist/darwin-arm64
rm -f dist/bikri-print-agent* dist/SHA256SUMS dist/*.zip dist/*.tar.gz

build() {
  local goos="$1" goarch="$2" out="$3" extra="${4:-}"
  echo "building ${goos}/${goarch} -> dist/${out}"
  # shellcheck disable=SC2086
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w -X main.version=${version} ${extra}" \
    -o "dist/${out}" ./cmd/bikri-print-agent
}

stage_readme() {
  local file="$1" platform="$2"
  cat > "$file" <<EOF
Bikri Print Agent ${version}
============================

Platform: ${platform}
Build:    ${version}

This package is unsigned. Windows SmartScreen or macOS Gatekeeper may warn on
first launch; verify the download against SHA256SUMS and only use builds from
the official Algovyn/Bikri release page.

The agent listens only on 127.0.0.1:17890 and prints through the operating
system's installed print queues. It does not send shop data to Algovyn.
EOF
}

build windows amd64 bikri-print-agent.exe "-H=windowsgui"
build linux amd64 bikri-print-agent
build linux arm64 bikri-print-agent-linux-arm64
build darwin amd64 bikri-print-agent-darwin-amd64
build darwin arm64 bikri-print-agent-darwin-arm64

# Windows portable package.
mkdir -p dist/windows-amd64
cp dist/bikri-print-agent.exe dist/windows-amd64/
cp install/windows/install.ps1 install/windows/uninstall.ps1 \
  install/windows/README.txt dist/windows-amd64/
stage_readme dist/windows-amd64/BUILD.txt "windows/amd64"

# Linux packages.
mkdir -p dist/linux-amd64 dist/linux-arm64
cp dist/bikri-print-agent dist/linux-amd64/
cp dist/bikri-print-agent-linux-arm64 dist/linux-arm64/bikri-print-agent
for dir in linux-amd64 linux-arm64; do
  cp install/linux/install.sh install/linux/bikri-print-agent.service "dist/${dir}/"
  stage_readme "dist/${dir}/BUILD.txt" "${dir}"
done

# macOS packages.
mkdir -p dist/darwin-amd64 dist/darwin-arm64
cp dist/bikri-print-agent-darwin-amd64 dist/darwin-amd64/bikri-print-agent
cp dist/bikri-print-agent-darwin-arm64 dist/darwin-arm64/bikri-print-agent
for dir in darwin-amd64 darwin-arm64; do
  cp install/macos/install.sh "dist/${dir}/"
  stage_readme "dist/${dir}/BUILD.txt" "${dir}"
done

python3 - <<'PY'
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path("dist/windows-amd64")
with ZipFile("dist/bikri-print-agent-windows-amd64.zip", "w", ZIP_DEFLATED) as archive:
    for path in sorted(root.iterdir()):
        archive.write(path, path.name)
PY

tar -czf dist/bikri-print-agent-linux-amd64.tar.gz -C dist/linux-amd64 .
tar -czf dist/bikri-print-agent-linux-arm64.tar.gz -C dist/linux-arm64 .
tar -czf dist/bikri-print-agent-darwin-amd64.tar.gz -C dist/darwin-amd64 .
tar -czf dist/bikri-print-agent-darwin-arm64.tar.gz -C dist/darwin-arm64 .

(
  cd dist
  sha256sum \
    bikri-print-agent-windows-amd64.zip \
    bikri-print-agent-linux-amd64.tar.gz \
    bikri-print-agent-linux-arm64.tar.gz \
    bikri-print-agent-darwin-amd64.tar.gz \
    bikri-print-agent-darwin-arm64.tar.gz > SHA256SUMS
)

echo "version: ${version}"
ls -lh dist/*.zip dist/*.tar.gz dist/SHA256SUMS
