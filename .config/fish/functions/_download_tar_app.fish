function _download_tar_app_mtime --argument-names file
    switch (uname -s)
        case Darwin
            command stat -f %m "$file" 2>/dev/null
        case '*'
            command stat -c %Y "$file" 2>/dev/null
    end
end

function _download_tar_app_is_stale --argument-names file max_age_days
    if not test -e "$file"
        return 0
    end

    set --local mtime (_download_tar_app_mtime "$file")
    set --local now (command date +%s)

    if not string match --quiet --regex '^[0-9]+$' -- "$mtime"
        return 0
    end

    if not string match --quiet --regex '^[0-9]+$' -- "$now"
        return 0
    end

    set --local age (math --scale=0 "$now - $mtime")
    set --local max_age_seconds (math --scale=0 "$max_age_days * 24 * 60 * 60")

    test "$age" -gt "$max_age_seconds"
end

function _download_tar_app_online --argument-names probe_url
    command curl --fail --silent --location --head --connect-timeout 3 --max-time 5 "$probe_url" >/dev/null 2>&1
end

function _download_tar_app_update --argument-names name url cache_dir target_rel bin_rel
    set --local tmp_dir (command mktemp -d "$cache_dir/.download.XXXXXX")

    if test -z "$tmp_dir"
        echo "$name update failed: could not create temp dir" >&2
        return 1
    end

    set --local archive "$tmp_dir/archive"
    set --local extract_dir "$tmp_dir/extract"
    command mkdir -p "$extract_dir"

    if not command curl --fail --silent --show-error --location --output "$archive" "$url"
        echo "$name update failed: download failed" >&2
        command rm -rf "$tmp_dir"
        return 1
    end

    set --local tar_flag -xzf

    if string match --quiet --regex '\.tar\.xz($|[?#])' -- "$url"
        set tar_flag -xJf
    end

    if not command tar -C "$extract_dir" "$tar_flag" "$archive" >/dev/null
        echo "$name update failed: archive extract failed" >&2
        command rm -rf "$tmp_dir"
        return 1
    end

    set --local new_target "$extract_dir/$target_rel"
    set --local new_bin "$extract_dir/$bin_rel"

    if not test -e "$new_target"
        echo "$name update failed: archive missing $target_rel" >&2
        command rm -rf "$tmp_dir"
        return 1
    end

    if not test -x "$new_bin"
        echo "$name update failed: archive missing executable $bin_rel" >&2
        command rm -rf "$tmp_dir"
        return 1
    end

    set --local target "$cache_dir/$target_rel"
    set --local backup "$target.old"
    command rm -rf "$backup"

    if test -e "$target"
        if not command mv "$target" "$backup"
            echo "$name update failed: could not back up current install" >&2
            command rm -rf "$tmp_dir"
            return 1
        end
    end

    if not command mv "$new_target" "$target"
        echo "$name update failed: could not install update" >&2

        if test -e "$backup"
            command mv "$backup" "$target"
        end

        command rm -rf "$tmp_dir"
        return 1
    end

    command touch "$cache_dir/$bin_rel"
    command rm -rf "$backup" "$tmp_dir"
end

function _download_tar_app --description "Ensure cached tarball app exists and is recent"
    argparse 'name=' 'url=' 'cache-dir=' 'target=' 'bin=' 'max-age-days=' 'probe-url=' -- $argv
    or return 2

    if not set -q _flag_name[1]
        echo "_download_tar_app: missing --name" >&2
        return 2
    end

    if not set -q _flag_url[1]
        echo "_download_tar_app: missing --url" >&2
        return 2
    end

    if not set -q _flag_cache_dir[1]
        echo "_download_tar_app: missing --cache-dir" >&2
        return 2
    end

    if not set -q _flag_target[1]
        echo "_download_tar_app: missing --target" >&2
        return 2
    end

    if not set -q _flag_bin[1]
        echo "_download_tar_app: missing --bin" >&2
        return 2
    end

    set --local name $_flag_name[1]
    set --local url $_flag_url[1]
    set --local cache_dir $_flag_cache_dir[1]
    set --local target_rel $_flag_target[1]
    set --local bin_rel $_flag_bin[1]
    set --local max_age_days 7
    set --local probe_url https://github.com

    if set -q _flag_max_age_days[1]
        set max_age_days $_flag_max_age_days[1]
    end

    if set -q _flag_probe_url[1]
        set probe_url $_flag_probe_url[1]
    end

    command mkdir -p "$cache_dir"

    set --local bin_path "$cache_dir/$bin_rel"
    set --local has_binary 0

    if test -x "$bin_path"
        set has_binary 1

        if not _download_tar_app_is_stale "$bin_path" "$max_age_days"
            return 0
        end
    end

    if not command -q curl
        if test "$has_binary" -eq 1
            echo "$name update failed: curl not found" >&2
            return 0
        end

        echo "$name install failed: curl not found" >&2
        return 1
    end

    if not command -q tar
        if test "$has_binary" -eq 1
            echo "$name update failed: tar not found" >&2
            return 0
        end

        echo "$name install failed: tar not found" >&2
        return 1
    end

    if not _download_tar_app_online "$probe_url"
        if test "$has_binary" -eq 1
            return 0
        end

        echo "$name install failed: no internet" >&2
        return 1
    end

    if _download_tar_app_update "$name" "$url" "$cache_dir" "$target_rel" "$bin_rel"
        return 0
    end

    if test "$has_binary" -eq 1; and test -x "$bin_path"
        return 0
    end

    return 1
end
