function _zellij_url --description "Get zellij download url"
    set --local arch
    set --local sys

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
            set sys unknown-linux-musl
        case Darwin
            set sys apple-darwin
        case '*'
            echo "Unsupported system: "(uname -s) >&2
            return 2
    end

    echo "https://github.com/zellij-org/zellij/releases/latest/download/zellij-$arch-$sys.tar.gz"
end

function zellij --description "better than tmux"
    set --local dir "$HOME/.local/cache/zellij"

    set --local url (_zellij_url)
    or return $status

    _download_tar_app \
        --name zellij \
        --url "$url" \
        --cache-dir "$dir" \
        --target zellij \
        --bin zellij \
        --max-age-days 7
    or return $status

    command "$dir/zellij" $argv
end
