function _helix_release --description "Get latest helix release"
    command curl --fail --silent --location --head --write-out '%{url_effective}' --output /dev/null https://github.com/helix-editor/helix/releases/latest \
        | string replace --regex '^.*/' ''
end

function _helix_url --description "Get helix download url"
    set --local arch
    set --local sys
    set --local release (_helix_release)
    or return $status

    if test -z "$release"
        echo "helix update failed: could not resolve latest release" >&2
        return 1
    end

    switch (uname -m)
        case x86_64 aarch64
            set arch (uname -m)
        case arm64
            set arch aarch64
        case '*'
            echo "Unsupported cpu arch: "(uname -m) >&2
            return 2
    end

    switch (uname -s)
        case Linux
            set sys linux
        case Darwin
            set sys macos
        case '*'
            echo "Unsupported system: "(uname -s) >&2
            return 2
    end

    echo "https://github.com/helix-editor/helix/releases/download/$release/helix-$release-$arch-$sys.tar.xz"
end

function helix --description "better than vim"
    set --local dir "$HOME/.local/cache/helix"
    set --local url (_helix_url)
    or return $status

    set --local release_dir (string replace --regex '^.*/(helix-[^/]+)\.tar\.xz$' '$1' "$url")

    _download_tar_app \
        --name helix \
        --url "$url" \
        --cache-dir "$dir" \
        --target "$release_dir" \
        --bin "$release_dir/hx" \
        --max-age-days 7
    or return $status

    env HELIX_RUNTIME="$dir/$release_dir/runtime" "$dir/$release_dir/hx" $argv
end
