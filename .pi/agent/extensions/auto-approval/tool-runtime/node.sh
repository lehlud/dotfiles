#!/usr/bin/env bash
set -euo pipefail

node_state=/tmp/pi-tools/node
command_name="$1"
shift

runtimes() {
    local roots=("$node_state/versions")
    if [ -d /opt/pi-tools/source/node ]; then roots+=(/opt/pi-tools/source/node); fi
    find "${roots[@]}" -maxdepth 4 -type f -path '*/bin/node' 2>/dev/null |
        while IFS= read -r binary; do
            prefix="${binary%/bin/node}"
            version="${prefix##*/}"
            [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && printf '%s %s\n' "$version" "$prefix"
        done | sort -k1,1V
    return 0
}

select_runtime() {
    local wanted="${1#v}"
    [[ "$wanted" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { printf 'nvm: use a numeric Node version\n' >&2; return 1; }
    runtimes | awk -v wanted="v$wanted" '$1 == wanted || index($1, wanted ".") == 1 { chosen=$2 } END { if (chosen) print chosen; else exit 1 }'
}

activate() {
    local prefix="$1"
    local record
    record="$(mktemp "$node_state/version.XXXXXX")"
    printf '%s\n' "${prefix##*/}" > "$record"
    mv -T -- "$record" "$node_state/version"
    printf 'Now using Node %s\n' "${prefix##*/}"
}

requested_version() {
    local wanted="${1:-}"
    if [ -z "$wanted" ]; then
        local directory="$PWD"
        while :; do
            if [ -f "$directory/.nvmrc" ]; then IFS= read -r wanted < "$directory/.nvmrc" || true; break; fi
            if [ "$directory" = / ]; then break; fi
            directory="${directory%/*}"; directory="${directory:-/}"
        done
    fi
    printf '%s\n' "$wanted"
}

if [ "$command_name" = nvm ]; then
    operation="${1:---help}"
    shift || true
    case "$operation" in
        use)
            wanted="$(requested_version "${1:-}")"
            prefix="$(select_runtime "$wanted")" || { printf 'nvm: Node %s is not installed; use nvm install with approved network access\n' "$wanted" >&2; exit 1; }
            activate "$prefix"
            ;;
        install) exec /bin/bash /opt/pi-tools/runtime/node-install.sh "$(requested_version "${1:-}")" ;;
        list|ls) runtimes | cut -d ' ' -f1 ;;
        current) cat "$node_state/version" 2>/dev/null || runtimes | tail -1 | cut -d ' ' -f1 ;;
        --help|-h) printf 'Sandbox nvm: use <version>, install <version>, list, current. Selection persists across approved Node actions in this session.\n' ;;
        *) printf 'Unsupported sandbox nvm command: %s\n' "$operation" >&2; exit 1 ;;
    esac
    exit
fi

if [ -f "$node_state/version" ]; then
    IFS= read -r version < "$node_state/version"
    prefix="$(select_runtime "$version")"
else
    prefix="$(runtimes | tail -1 | cut -d ' ' -f2-)"
fi
[ -n "$prefix" ] || { printf 'Node is not installed; use nvm install with approved network access\n' >&2; exit 1; }
export HOME="$node_state/home" XDG_CACHE_HOME="$node_state/home/.cache" XDG_CONFIG_HOME="$node_state/home/.config" XDG_DATA_HOME="$node_state/home/.local/share"
export PATH="$prefix/bin:$PATH"
case "$command_name" in
    npm|npx) exec "$prefix/bin/node" "$prefix/lib/node_modules/npm/bin/$command_name-cli.js" "$@" ;;
    corepack) exec "$prefix/bin/node" "$prefix/lib/node_modules/corepack/dist/corepack.js" "$@" ;;
    node) exec "$prefix/bin/node" "$@" ;;
    *) exit 1 ;;
esac
