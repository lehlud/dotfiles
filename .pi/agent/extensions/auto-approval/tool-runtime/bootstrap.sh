#!/usr/bin/env bash
set -euo pipefail

ensure_directory() {
    if [ -L "$1" ] || { [ -e "$1" ] && [ ! -d "$1" ]; }; then
        printf 'Local tool storage is not a regular directory: %s\n' "$1" >&2
        exit 1
    fi

    mkdir -p -- "$1"
}

ensure_directory /tmp/pi-tools
ensure_directory /tmp/home/pi-tools
ensure_directory /tmp/home/pi-tools/bin
tool_bin=/tmp/home/pi-tools/bin

while [ "$1" != -- ]; do
    tool_name="$1"
    shift
    [[ "$tool_name" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]] || exit 1
    if [ "$tool_name" = node ]; then
        ensure_directory /tmp/pi-tools/node
        ensure_directory /tmp/pi-tools/node/versions
        ensure_directory /tmp/pi-tools/node/home
        for command in node npm npx corepack nvm; do
            printf '#!/bin/bash\nexec /bin/bash /opt/pi-tools/runtime/node.sh %q "$@"\n' "$command" > "$tool_bin/$command"
            chmod +x "$tool_bin/$command"
        done

        continue
    fi

    tool_home="/tmp/pi-tools/$tool_name/home"
    for directory in "/tmp/pi-tools/$tool_name" "$tool_home" "$tool_home/.local" "$tool_home/.local/bin" "$tool_home/.local/cache"; do
        ensure_directory "$directory"
    done

    if [ -f "/opt/pi-tools/source/$tool_name/helper" ]; then
        cp --remove-destination -- "/opt/pi-tools/source/$tool_name/helper" "$tool_home/.local/bin/auto-update-app.bash"
    fi

    cp --remove-destination -- "/opt/pi-tools/source/$tool_name/launcher" "$tool_home/.local/bin/$tool_name"
    cache="$tool_home/.local/cache/$tool_name"
    if [ -e "$cache" ] || [ -L "$cache" ]; then
        ensure_directory "$cache"
    elif [ -d "/opt/pi-tools/source/$tool_name/cache" ]; then
        cp -a -- "/opt/pi-tools/source/$tool_name/cache" "$cache"
    fi

    printf '#!/bin/bash\nexport HOME=%q XDG_CACHE_HOME=%q XDG_CONFIG_HOME=%q XDG_DATA_HOME=%q\nexec %q "$@"\n' \
        "$tool_home" "$tool_home/.cache" "$tool_home/.config" "$tool_home/.local/share" "$tool_home/.local/bin/$tool_name" > "$tool_bin/$tool_name"
    chmod +x "$tool_bin/$tool_name"
done

shift
export PATH="$tool_bin:$PATH"
exec "$@"
