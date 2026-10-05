#!/usr/bin/env bash
set -euo pipefail
wanted="${1#v}"
[[ "$wanted" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { printf 'nvm install: use a numeric Node version\n' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) printf 'Unsupported Node architecture\n' >&2; exit 1 ;; esac
download="$(mktemp -d /tmp/pi-tools/node/download.XXXXXX)"
trap 'rm -rf -- "$download"' EXIT
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 https://nodejs.org/dist/index.json -o "$download/index.json"
version="$(python3 - "$download/index.json" "$wanted" <<'PY'
import json, re, sys
wanted = 'v' + sys.argv[2]
for item in json.load(open(sys.argv[1])):
    version = item['version']
    if re.fullmatch(r'v\d+\.\d+\.\d+', version) and (version == wanted or version.startswith(wanted + '.')):
        print(version)
        break
else:
    raise SystemExit('Requested Node version not found')
PY
)"
archive="node-$version-linux-$arch.tar.xz"
base="https://nodejs.org/dist/$version"
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 180 "$base/$archive" -o "$download/$archive"
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 "$base/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
awk -v file="$archive" '$2 == file {print}' "$download/SHASUMS256.txt" > "$download/checksum"
[ -s "$download/checksum" ] || { printf 'Node checksum missing\n' >&2; exit 1; }
(cd "$download" && sha256sum --check checksum)
tar -xJf "$download/$archive" -C "$download" --no-same-owner
destination="/tmp/pi-tools/node/versions/$version"
if [ -L "$destination" ]; then
    printf 'Node installation destination is a symlink\n' >&2
    exit 1
elif [ -e "$destination" ]; then
    printf 'Node %s is already present; leaving the session installation intact\n' "$version"
else
    mv -- "$download/node-$version-linux-$arch" "$destination"
fi
/bin/bash /opt/pi-tools/runtime/node.sh nvm use "$version"
