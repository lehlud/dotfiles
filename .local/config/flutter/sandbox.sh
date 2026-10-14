#!/usr/bin/env bash
set -euo pipefail

command_name="${FLUTTER_CONTAINER_COMMAND:-flutter}"
runtime_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
state=/tmp/pi-tools/flutter
sdk="$state/sdk"

if [ "$(uname -s)" != Linux ] || { [ ! -f /run/.containerenv ] && [ ! -f /.dockerenv ]; }; then
    printf 'Flutter sandbox mode requires a Linux container\n' >&2
    exit 1
fi

# Dart profiling endpoints must not survive into the next action's /tmp validation.
export HOME=/tmp/home/flutter
mkdir -p -- "$HOME"

export XDG_CACHE_HOME="$HOME/.cache"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
export PUB_CACHE="$state/pub-cache" GRADLE_USER_HOME="$state/gradle"
export FLUTTER_SUPPRESS_ANALYTICS=true DART_SUPPRESS_ANALYTICS=true CI=true

if [ -L "$sdk" ] || { [ -e "$sdk" ] && [ ! -d "$sdk" ]; }; then
    printf 'Sandbox Flutter SDK is not a regular directory\n' >&2
    exit 1
fi

if [ ! -d "$sdk" ]; then
    staging="$(mktemp -d "$state/setup.XXXXXX")"
    trap 'rm -rf -- "$staging"' EXIT

    if [ -d /opt/pi-tools/source/flutter/sdk ]; then
        cp -a -- /opt/pi-tools/source/flutter/sdk "$staging/flutter"
    else
        /bin/bash "$runtime_directory/sandbox-install.sh" "$staging"
    fi

    mv -T -- "$staging/flutter" "$sdk"
    rm -rf -- "$staging"
    trap - EXIT
fi

source "$runtime_directory/native-runtime.sh"

if ! native_runtime "$sdk/bin/cache/dart-sdk/bin/dart"; then
    printf 'Sandbox Flutter requires a native Linux Dart runtime; cached SDK is incompatible\n' >&2
    exit 1
fi

export PATH="$sdk/bin:$PATH"

case "$command_name" in
    flutter|dart)
        exec "$sdk/bin/$command_name" "$@"
        ;;
    *)
        printf 'Unsupported sandbox Flutter command\n' >&2
        exit 1
        ;;
esac

