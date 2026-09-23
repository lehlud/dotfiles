#!/usr/bin/env bash

auto_update_mtime() {
    case "$(uname -s)" in
        Darwin)
            stat -f %m "$1" 2>/dev/null
            ;;
        *)
            stat -c %Y "$1" 2>/dev/null
            ;;
    esac
}

auto_update_platform_os() {
    case "$(uname -s)" in
        Darwin)
            printf '%s\n' darwin
            ;;
        Linux)
            printf '%s\n' linux
            ;;
        *)
            uname -s | tr '[:upper:]' '[:lower:]'
            ;;
    esac
}

auto_update_platform_arch() {
    case "$(uname -m)" in
        x86_64 | amd64)
            printf '%s\n' x86_64
            ;;
        aarch64 | arm64)
            printf '%s\n' aarch64
            ;;
        *)
            uname -m | tr '[:upper:]' '[:lower:]'
            ;;
    esac
}

auto_update_platform_suffix() {
    printf '%s-%s\n' "$(auto_update_platform_os)" "$(auto_update_platform_arch)"
}

auto_update_platform_cache_dir() {
    local base_dir="$1"
    printf '%s/%s\n' "${base_dir%/}" "$(auto_update_platform_suffix)"
}

auto_update_is_stale() {
    local file="$1"
    local max_age_days="$2"

    [ -e "$file" ] || return 0

    local mtime
    local now
    mtime="$(auto_update_mtime "$file")" || return 0
    now="$(date +%s)" || return 0

    [[ "$mtime" =~ ^[0-9]+$ ]] || return 0
    [[ "$now" =~ ^[0-9]+$ ]] || return 0

    ((now - mtime > max_age_days * 24 * 60 * 60))
}

auto_update_online() {
    local probe_url="${1:-https://github.com}"
    curl --fail --silent --location --head --connect-timeout 3 --max-time 5 "$probe_url" >/dev/null 2>&1
}

_auto_update_progress_enabled() {
    case "${AUTO_UPDATE_PROGRESS:-auto}" in
        always | yes | true | 1)
            return 0
            ;;
        never | no | false | 0)
            return 1
            ;;
        *)
            [ -t 2 ]
            ;;
    esac
}

_auto_update_progress_bar() {
    local label="$1"
    local width=24
    local step=0
    local pos
    local left
    local right

    while :; do
        pos=$((step % width))
        left=$(printf '%*s' "$pos" '' | tr ' ' '=')
        right=$(printf '%*s' "$((width - pos - 1))" '' | tr ' ' ' ')
        printf '\r%s [%s>%s]' "$label" "$left" "$right" >&2
        step=$((step + 1))
        sleep 0.1
    done
}

_auto_update_run_with_progress() {
    local label="$1"
    local status
    local progress_pid
    shift

    if ! _auto_update_progress_enabled; then
        "$@"
        return $?
    fi

    _auto_update_progress_bar "$label" &
    progress_pid=$!

    "$@"
    status=$?

    kill "$progress_pid" 2>/dev/null
    wait "$progress_pid" 2>/dev/null

    if [ "$status" -eq 0 ]; then
        printf '\r%s [%s] done\n' "$label" "$(printf '%*s' 24 '' | tr ' ' '=')" >&2
    else
        printf '\r%s [%s] failed\n' "$label" "$(printf '%*s' 24 '' | tr ' ' '=')" >&2
    fi

    return "$status"
}

_auto_update_download() {
    local name="$1"
    local action="$2"
    local url="$3"
    local archive="$4"

    if _auto_update_progress_enabled; then
        printf '%s %s: downloading\n' "$name" "$action" >&2
        curl --fail --location --progress-bar --output "$archive" "$url"
    else
        curl --fail --silent --show-error --location --output "$archive" "$url"
    fi
}

auto_update_latest_release_tag() {
    local repo="$1"
    local latest_url
    latest_url="$(curl --fail --silent --show-error --location --head --write-out '%{url_effective}' --output /dev/null "https://github.com/$repo/releases/latest")" || return 1
    printf '%s\n' "${latest_url##*/}"
}

_auto_update_tar_flag() {
    case "$1" in
        *.tar.xz | *.tar.xz\?* | *.tar.xz#*)
            printf '%s\n' -xJf
            ;;
        *)
            printf '%s\n' -xzf
            ;;
    esac
}

_auto_update_extract_tar() {
    local url="$1"
    local archive="$2"
    local extract_dir="$3"
    local label="${4:-extracting}"
    local tar_flag

    tar_flag="$(_auto_update_tar_flag "$url")"
    _auto_update_run_with_progress "$label" tar -C "$extract_dir" "$tar_flag" "$archive" >/dev/null
}

_auto_update_extract_zip() {
    local _url="$1"
    local archive="$2"
    local extract_dir="$3"
    local label="${4:-extracting}"

    _auto_update_run_with_progress "$label" unzip -q "$archive" -d "$extract_dir" >/dev/null
}

_auto_update_install_app() {
    local name="$1"
    local action="$2"
    local url="$3"
    local cache_dir="$4"
    local source_rel="$5"
    local source_bin_rel="$6"
    local target_rel="$7"
    local bin_rel="$8"
    local extractor="$9"
    local tmp_dir
    local archive
    local extract_dir
    local source
    local source_bin
    local target
    local backup

    tmp_dir="$(mktemp -d "$cache_dir/.download.XXXXXX")" || {
        printf '%s %s failed: could not create temp dir\n' "$name" "$action" >&2
        return 1
    }

    archive="$tmp_dir/archive"
    extract_dir="$tmp_dir/extract"

    if ! mkdir -p "$extract_dir"; then
        printf '%s %s failed: could not create extract dir\n' "$name" "$action" >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! _auto_update_download "$name" "$action" "$url" "$archive"; then
        printf '%s %s failed: download failed\n' "$name" "$action" >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! "$extractor" "$url" "$archive" "$extract_dir" "$name $action: extracting"; then
        printf '%s %s failed: archive extract failed\n' "$name" "$action" >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    source="$extract_dir/$source_rel"
    source_bin="$extract_dir/$source_bin_rel"

    if [ ! -e "$source" ]; then
        printf '%s %s failed: archive missing %s\n' "$name" "$action" "$source_rel" >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    if [ ! -x "$source_bin" ]; then
        printf '%s %s failed: archive missing executable %s\n' "$name" "$action" "$source_bin_rel" >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    target="$cache_dir/$target_rel"
    backup="$target.old"
    rm -rf "$backup"

    if [ -e "$target" ] && ! mv "$target" "$backup"; then
        printf '%s %s failed: could not back up current install\n' "$name" "$action" >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! mv "$source" "$target"; then
        printf '%s %s failed: could not install update\n' "$name" "$action" >&2

        if [ -e "$backup" ]; then
            mv "$backup" "$target"
        fi

        rm -rf "$tmp_dir"
        return 1
    fi

    touch "$cache_dir/$bin_rel"
    if [ -n "${AUTO_UPDATE_VERSION:-}" ]; then
        if ! printf '%s\n' "$AUTO_UPDATE_VERSION" >"$cache_dir/.auto-update-version"; then
            printf '%s %s warning: could not write version metadata\n' "$name" "$action" >&2
        fi
    fi
    rm -rf "$backup" "$tmp_dir"
}

_auto_update_install_tar_app() {
    _auto_update_install_app "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" _auto_update_extract_tar
}

_auto_update_install_zip_app() {
    _auto_update_install_app "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" _auto_update_extract_zip
}

_auto_update_ensure_app() {
    local name="$1"
    local cache_dir="$2"
    local target_rel="$3"
    local bin_rel="$4"
    local max_age_days="${5:-3}"
    local resolver="$6"
    local probe_url="${7:-https://github.com}"
    local archive_tool="$8"
    local installer="$9"
    local bin_path="$cache_dir/$bin_rel"
    local version_path="$cache_dir/.auto-update-version"
    local stale_path="$bin_path"
    local has_binary=0
    local action=install
    local installed_version

    if ! mkdir -p "$cache_dir"; then
        printf '%s install failed: could not create cache dir\n' "$name" >&2
        return 1
    fi

    if [ -x "$bin_path" ]; then
        has_binary=1
        action=update
        if [ -e "$version_path" ]; then
            stale_path="$version_path"
        fi

        if ! auto_update_is_stale "$stale_path" "$max_age_days"; then
            return 0
        fi
    fi

    if ! command -v curl >/dev/null 2>&1; then
        if [ "$has_binary" -eq 1 ]; then
            printf '%s update failed: curl not found\n' "$name" >&2
            return 0
        fi

        printf '%s install failed: curl not found\n' "$name" >&2
        return 1
    fi

    if ! command -v "$archive_tool" >/dev/null 2>&1; then
        if [ "$has_binary" -eq 1 ]; then
            printf '%s update failed: %s not found\n' "$name" "$archive_tool" >&2
            return 0
        fi

        printf '%s install failed: %s not found\n' "$name" "$archive_tool" >&2
        return 1
    fi

    if ! auto_update_online "$probe_url"; then
        if [ "$has_binary" -eq 1 ]; then
            return 0
        fi

        printf '%s install failed: no internet\n' "$name" >&2
        return 1
    fi

    unset AUTO_UPDATE_URL AUTO_UPDATE_SOURCE_REL AUTO_UPDATE_SOURCE_BIN_REL AUTO_UPDATE_VERSION

    if ! "$resolver"; then
        printf '%s %s failed: could not resolve download\n' "$name" "$action" >&2
        if [ "$has_binary" -eq 1 ]; then
            return 0
        fi

        return 1
    fi

    if [ -z "${AUTO_UPDATE_URL:-}" ] || [ -z "${AUTO_UPDATE_SOURCE_REL:-}" ] || [ -z "${AUTO_UPDATE_SOURCE_BIN_REL:-}" ]; then
        printf '%s %s failed: resolver returned incomplete download metadata\n' "$name" "$action" >&2
        if [ "$has_binary" -eq 1 ]; then
            return 0
        fi

        return 1
    fi

    if [ "$has_binary" -eq 1 ] && [ -n "${AUTO_UPDATE_VERSION:-}" ] && [ -r "$version_path" ]; then
        IFS= read -r installed_version <"$version_path" || installed_version=
        if [ "$installed_version" = "$AUTO_UPDATE_VERSION" ]; then
            if ! touch "$version_path"; then
                printf '%s update warning: could not refresh version metadata\n' "$name" >&2
            fi
            return 0
        fi
    fi

    if "$installer" "$name" "$action" "$AUTO_UPDATE_URL" "$cache_dir" "$AUTO_UPDATE_SOURCE_REL" "$AUTO_UPDATE_SOURCE_BIN_REL" "$target_rel" "$bin_rel"; then
        return 0
    fi

    if [ "$has_binary" -eq 1 ] && [ -x "$bin_path" ]; then
        return 0
    fi

    return 1
}

auto_update_ensure_tar_app() {
    _auto_update_ensure_app "$1" "$2" "$3" "$4" "${5:-3}" "$6" "${7:-https://github.com}" tar _auto_update_install_tar_app
}

auto_update_ensure_zip_app() {
    _auto_update_ensure_app "$1" "$2" "$3" "$4" "${5:-3}" "$6" "${7:-https://github.com}" unzip _auto_update_install_zip_app
}

auto_update_ensure_docker_image() {
    local name="$1"
    local image="$2"
    local cache_dir="$3"
    local max_age_days="${4:-3}"
    local platform="${5:-}"
    local marker="$cache_dir/.auto-update-checked"
    local installed=0
    local pull_args=()

    if ! command -v docker >/dev/null 2>&1; then
        printf '%s: docker not found\n' "$name" >&2
        return 127
    fi
    if ! mkdir -p "$cache_dir"; then
        printf '%s: could not create cache dir\n' "$name" >&2
        return 1
    fi
    if [ -n "$platform" ]; then
        pull_args+=(--platform "$platform")
    fi
    if docker image inspect "$image" >/dev/null 2>&1; then
        installed=1
        if ! auto_update_is_stale "$marker" "$max_age_days"; then
            return 0
        fi
    fi
    if docker pull --quiet "${pull_args[@]}" "$image" >/dev/null; then
        touch "$marker"
        return 0
    fi
    if [ "$installed" -eq 1 ]; then
        printf '%s update failed; using cached image\n' "$name" >&2
        return 0
    fi
    printf '%s install failed: could not pull image\n' "$name" >&2
    return 1
}
