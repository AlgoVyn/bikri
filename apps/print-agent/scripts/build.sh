#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

version="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
mkdir -p dist
rm -f dist/bikri-print-agent dist/bikri-print-agent.exe dist/*.tar.gz

build() {
  local goos="$1" goarch="$2" out="$3" extra="${4:-}"
  echo "building ${goos}/${goarch} -> dist/${out}"
  # shellcheck disable=SC2086
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w -X main.version=${version} ${extra}" \
    -o "dist/${out}" ./cmd/bikri-print-agent
}

build windows amd64 bikri-print-agent.exe "-H=windowsgui"
build linux amd64 bikri-print-agent
build linux arm64 bikri-print-agent-linux-arm64
build darwin amd64 bikri-print-agent-darwin-amd64
build darwin arm64 bikri-print-agent-darwin-arm64

for dir in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
  mkdir -p "dist/${dir}"
done
cp dist/bikri-print-agent dist/linux-amd64/bikri-print-agent
cp dist/bikri-print-agent-linux-arm64 dist/linux-arm64/bikri-print-agent
cp dist/bikri-print-agent-darwin-amd64 dist/darwin-amd64/bikri-print-agent
cp dist/bikri-print-agent-darwin-arm64 dist/darwin-arm64/bikri-print-agent

(cd dist && sha256sum bikri-print-agent.exe bikri-print-agent-linux-arm64 \
  bikri-print-agent-darwin-amd64 bikri-print-agent-darwin-arm64 \
  bikri-print-agent > SHA256SUMS)

echo "version: ${version}"
