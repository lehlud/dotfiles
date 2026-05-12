function _fastfetch_url --description "Get fastfetch download url"
    set --local arch
    set --local sys

    switch (uname -m)
        case x86_64
            set arch amd64
        case arm64 aarch64
            set arch aarch64
        case '*'
            echo "Unsupported cpu arch: "(uname -m) >&2
            return 2
    end

    switch (uname -s)
        case Linux
            set sys linux
        case '*'
            echo "Unsupported system: "(uname -s) >&2
            return 2
    end

    echo "https://github.com/fastfetch-cli/fastfetch/releases/latest/download/fastfetch-$sys-$arch.tar.gz"
end

function fastfetch --description "better than neofetch"
    set --local dir "$HOME/.local/cache/fastfetch"

    set --local url (_fastfetch_url)
    or return $status

    set --local release_dir (string replace --regex '^.*/(fastfetch-[^/]+)\.tar\.gz$' '$1' "$url")
    set --local exe_file "$release_dir/usr/bin/fastfetch"

    _download_tar_app \
        --name fastfetch \
        --url "$url" \
        --cache-dir "$dir" \
        --target "$release_dir" \
        --bin "$exe_file" \
        --max-age-days 7
    or return $status

    command "$dir/$exe_file" $argv
end
