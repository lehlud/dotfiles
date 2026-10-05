#!/usr/bin/env bash
set -euo pipefail

node_state=/tmp/pi-tools/node
command_name="$1"
shift

native_runtime() {
    local bytes machine
    case "$(uname -m)" in x86_64) machine=3e ;; aarch64) machine=b7 ;; *) return 1 ;; esac
    [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ] || return 1
    # ELF64, little-endian, current version, System V/Linux ABI, EXEC/DYN,
    # and the machine used by this Linux sandbox. Never execute a probe.
    read -ra bytes <<< "$(od -An -v -t x1 -N64 -w64 -- "$1" 2>/dev/null)"
    [ "${#bytes[@]}" = 64 ] && [ "${bytes[*]:0:7}" = '7f 45 4c 46 02 01 01' ] \
        && [[ "${bytes[7]}" = 00 || "${bytes[7]}" = 03 ]] \
        && [[ "${bytes[16]}" = 02 || "${bytes[16]}" = 03 ]] && [ "${bytes[17]}" = 00 ] \
        && [ "${bytes[18]} ${bytes[19]}" = "$machine 00" ] && [ "${bytes[*]:20:4}" = '01 00 00 00' ] \
        && [ "${bytes[52]} ${bytes[53]}" = '40 00' ]
}

runtimes() {
    local roots=("$node_state/versions")
    if [ -d /opt/pi-tools/source/node ]; then roots+=(/opt/pi-tools/source/node); fi
    find "${roots[@]}" -maxdepth 4 -type f -path '*/bin/node' 2>/dev/null |
        while IFS= read -r binary; do
            prefix="${binary%/bin/node}"
            version="${prefix##*/}"
            if [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && native_runtime "$binary"; then
                printf '%s %s\n' "$version" "$prefix"
            fi
        done | sort -k1,1V
    return 0
}

active_runtime() {
    if [ -f "$node_state/version" ]; then
        local version
        IFS= read -r version < "$node_state/version"
        select_runtime "$version" || { printf 'nvm: Selected Node %s has no compatible Linux runtime; use nvm use or an approved nvm install\n' "$version" >&2; return 1; }
    else
        runtimes | tail -1 | cut -d ' ' -f2-
    fi
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
            prefix="$(select_runtime "$wanted")" || { printf 'nvm: Node %s has no compatible Linux runtime; use nvm install %s with network: true and independent approval\n' "$wanted" "$wanted" >&2; exit 1; }
            activate "$prefix"
            ;;
        install) exec /bin/bash /opt/pi-tools/runtime/node-install.sh "$(requested_version "${1:-}")" ;;
        list|ls) runtimes | cut -d ' ' -f1 ;;
        current) prefix="$(active_runtime)"; version="${prefix##*/}"; printf '%s\n' "${version:-none}" ;;
        help|--help|-h) printf 'Sandbox nvm (Linux): use <version>, install <version>, list (ls), current, help. Selection persists across approved Node actions in this session. Only compatible Linux binaries are used; downloads require network: true and independent approval.\n' ;;
        *) printf 'Unsupported sandbox nvm command: %s\n' "$operation" >&2; exit 1 ;;
    esac
    exit
fi

prefix="$(active_runtime)"
[ -n "$prefix" ] || { printf 'No compatible Linux Node runtime is installed; use nvm install 22 with network: true and independent approval\n' >&2; exit 1; }
export HOME="$node_state/home" XDG_CACHE_HOME="$node_state/home/.cache" XDG_CONFIG_HOME="$node_state/home/.config" XDG_DATA_HOME="$node_state/home/.local/share"
export PATH="$prefix/bin:$PATH"
case "$command_name" in
    npm|npx) exec "$prefix/bin/node" "$prefix/lib/node_modules/npm/bin/$command_name-cli.js" "$@" ;;
    corepack) exec "$prefix/bin/node" "$prefix/lib/node_modules/corepack/dist/corepack.js" "$@" ;;
    node) exec "$prefix/bin/node" "$@" ;;
    *) exit 1 ;;
esac
