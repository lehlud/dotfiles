#!/usr/bin/env bash
set -euo pipefail

staging="$1"
runtime_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
base=https://storage.googleapis.com/flutter_infra_release/releases

for prerequisite in curl git python3 unzip tar xz sha256sum; do
    if ! command -v "$prerequisite" >/dev/null 2>&1; then
        printf 'Flutter container prerequisite is missing: %s\n' "$prerequisite" >&2
        exit 1
    fi

done

case "$(uname -m)" in
    x86_64)
        arch=x64
        ;;
    aarch64)
        arch=arm64
        ;;
    *)
        printf 'Unsupported Flutter Linux architecture\n' >&2
        exit 1
        ;;
esac

if ! curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 \
    --proto '=https' --proto-redir '=https' \
    "$base/releases_linux.json" -o "$staging/releases.json"; then
    printf 'Flutter SDK setup requires network: true and independent approval; no Linux SDK is cached in this session\n' >&2
    exit 1
fi

python3 "$runtime_directory/sandbox-release.py" "$staging/releases.json" "$arch" > "$staging/release"
mapfile -t release < "$staging/release"

curl --fail --silent --show-error --location --connect-timeout 10 --max-time 600 \
    --proto '=https' --proto-redir '=https' \
    "$base/${release[0]}" -o "$staging/flutter.tar.xz"
printf '%s  flutter.tar.xz\n' "${release[1]}" > "$staging/checksum"
(cd "$staging" && sha256sum --check checksum)
tar -xJf "$staging/flutter.tar.xz" -C "$staging" --no-same-owner

source "$runtime_directory/native-runtime.sh"
if [ "$arch" = arm64 ] && ! native_runtime "$staging/flutter/bin/cache/dart-sdk/bin/dart"; then
    # Never execute the bundle's foreign Dart. Flutter's verified shell bootstrap
    # downloads Linux arm64 Dart for the exact engine revision of this release.
    rm -rf -- "$staging/flutter/bin/cache/dart-sdk"
    rm -f -- "$staging/flutter/bin/cache/engine-dart-sdk.stamp"
    "$staging/flutter/bin/flutter" --version
fi

