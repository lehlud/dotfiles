_fish_launcher_mtime() {
    case "$(uname -s)" in
        Darwin)
            stat -f %m "$1" 2>/dev/null
            ;;
        *)
            stat -c %Y "$1" 2>/dev/null
            ;;
    esac
}

_fish_launcher_is_stale() {
    local file="$1"
    local max_age_days="$2"

    [ -e "$file" ] || return 0

    local mtime
    local now
    mtime="$(_fish_launcher_mtime "$file")" || return 0
    now="$(date +%s)" || return 0

    [[ "$mtime" =~ ^[0-9]+$ ]] || return 0
    [[ "$now" =~ ^[0-9]+$ ]] || return 0

    ((now - mtime > max_age_days * 24 * 60 * 60))
}

_fish_launcher_online() {
    curl --fail --silent --location --head --connect-timeout 3 --max-time 5 https://github.com >/dev/null 2>&1
}

_fish_launcher_arch() {
    case "$(uname -m)" in
        x86_64)
            printf '%s\n' x86_64
            ;;
        aarch64 | arm64)
            printf '%s\n' aarch64
            ;;
        *)
            printf 'fish update failed: unsupported cpu arch: %s\n' "$(uname -m)" >&2
            return 2
            ;;
    esac
}

_fish_launcher_latest_version() {
    local latest_url
    latest_url="$(curl --fail --silent --show-error --location --head --write-out '%{url_effective}' --output /dev/null https://github.com/fish-shell/fish-shell/releases/latest)" || return 1
    printf '%s\n' "${latest_url##*/}"
}

_fish_launcher_update() {
    local cache_dir="$1"
    local fish_bin="$2"
    local tmp_dir
    local archive
    local extract_dir
    local version
    local arch
    local url
    local backup

    tmp_dir="$(mktemp -d "$cache_dir/.download.XXXXXX")" || {
        printf 'fish update failed: could not create temp dir\n' >&2
        return 1
    }

    archive="$tmp_dir/fish.tar.xz"
    extract_dir="$tmp_dir/extract"
    mkdir -p "$extract_dir" || {
        printf 'fish update failed: could not create extract dir\n' >&2
        rm -rf "$tmp_dir"
        return 1
    }

    arch="$(_fish_launcher_arch)" || {
        rm -rf "$tmp_dir"
        return 1
    }

    case "$(uname -s)" in
        Linux)
            ;;
        *)
            printf 'fish update failed: unsupported system: %s\n' "$(uname -s)" >&2
            rm -rf "$tmp_dir"
            return 1
            ;;
    esac

    version="$(_fish_launcher_latest_version)" || {
        printf 'fish update failed: could not resolve latest release\n' >&2
        rm -rf "$tmp_dir"
        return 1
    }

    url="https://github.com/fish-shell/fish-shell/releases/download/$version/fish-$version-linux-$arch.tar.xz"

    if ! curl --fail --silent --show-error --location --output "$archive" "$url"; then
        printf 'fish update failed: download failed\n' >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! tar -C "$extract_dir" -xJf "$archive" >/dev/null; then
        printf 'fish update failed: archive extract failed\n' >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    if [ ! -x "$extract_dir/fish" ]; then
        printf 'fish update failed: archive missing executable fish\n' >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    backup="$fish_bin.old"
    rm -f "$backup"

    if [ -e "$fish_bin" ] && ! mv "$fish_bin" "$backup"; then
        printf 'fish update failed: could not back up current install\n' >&2
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! mv "$extract_dir/fish" "$fish_bin"; then
        printf 'fish update failed: could not install update\n' >&2

        if [ -e "$backup" ]; then
            mv "$backup" "$fish_bin"
        fi

        rm -rf "$tmp_dir"
        return 1
    fi

    touch "$fish_bin"
    rm -f "$backup"
    rm -rf "$tmp_dir"
}

_fish_launcher_exec() {
    local fish_bin="$1"

    if [ -x "$fish_bin" ]; then
        exec "$fish_bin"
        printf 'fish launch failed: exec failed: %s\n' "$fish_bin" >&2
        return 1
    fi

    if command -v fish >/dev/null 2>&1; then
        exec fish
        printf 'fish launch failed: exec failed: fish\n' >&2
        return 1
    fi

    return 1
}

_fish_launcher_main() {
    [ -n "${BASH_VERSION:-}" ] || return 0

    case "$-" in
        *i*)
            ;;
        *)
            return 0
            ;;
    esac

    [ -z "${I_WANT_BASH+x}" ] || return 0

    local cache_dir="${XDG_CACHE_HOME:-$HOME/.local/cache}/fish"
    local fish_bin="$cache_dir/fish"
    local has_binary=0

    mkdir -p "$cache_dir" || {
        printf 'fish install failed: could not create cache dir\n' >&2
        return 0
    }

    if [ -x "$fish_bin" ]; then
        has_binary=1

        if ! _fish_launcher_is_stale "$fish_bin" 7; then
            _fish_launcher_exec "$fish_bin"
            return 0
        fi
    fi

    if ! command -v curl >/dev/null 2>&1; then
        if [ "$has_binary" -eq 1 ]; then
            printf 'fish update failed: curl not found\n' >&2
            _fish_launcher_exec "$fish_bin"
            return 0
        fi

        printf 'fish install failed: curl not found\n' >&2
        _fish_launcher_exec "$fish_bin"
        return 0
    fi

    if ! command -v tar >/dev/null 2>&1; then
        if [ "$has_binary" -eq 1 ]; then
            printf 'fish update failed: tar not found\n' >&2
            _fish_launcher_exec "$fish_bin"
            return 0
        fi

        printf 'fish install failed: tar not found\n' >&2
        _fish_launcher_exec "$fish_bin"
        return 0
    fi

    if ! _fish_launcher_online; then
        if [ "$has_binary" -eq 1 ]; then
            _fish_launcher_exec "$fish_bin"
            return 0
        fi

        printf 'fish install failed: no internet\n' >&2
        _fish_launcher_exec "$fish_bin"
        return 0
    fi

    if _fish_launcher_update "$cache_dir" "$fish_bin"; then
        _fish_launcher_exec "$fish_bin"
        return 0
    fi

    if [ "$has_binary" -eq 1 ] && [ -x "$fish_bin" ]; then
        _fish_launcher_exec "$fish_bin"
        return 0
    fi

    _fish_launcher_exec "$fish_bin"
    return 0
}

_fish_launcher_main

unset -f _fish_launcher_mtime _fish_launcher_is_stale _fish_launcher_online _fish_launcher_arch _fish_launcher_latest_version _fish_launcher_update _fish_launcher_exec _fish_launcher_main
