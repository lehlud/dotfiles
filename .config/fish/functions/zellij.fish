function _zellij_url --description "Get zellij download url"
    switch (uname -m)
        case x86_64 aarch64
            set arch (uname -m)
        case arm64
            set arch aarch64
        case '*'
            echo "Unsupported cpu arch: "(uname -m)
            exit 2
    end

    switch (uname -s)
        case Linux
            set sys unknown-linux-musl
        case Darwin
            set sys apple-darwin
        case '*'
            echo "Unsupported system: "(uname -s)
            set --erase arch
            exit 2
    end

    set --local url "https://github.com/zellij-org/zellij/releases/latest/download/zellij-$arch-$sys.tar.gz"
    set --erase arch
    set --erase sys

    echo "$url"
end

function zellij --description "better than tmux"
    set --local dir "$HOME/.local/cache/zellij"
    command mkdir -p "$dir"

    set --local exe_file "$dir/zellij"
    set --local timestamp_file "$dir/timestamp"

    if not test -f "$exe_file"
        command rm -f "$timestamp_file"
    end

    if test -f "$timestamp_file"
        set --local ts (cat "$timestamp_file")
        set --local now (date +%s)
        set --local seven_days (math 7 \* 24 \* 60 \* 60)

        if test (math $now - $ts) -gt $seven_days
            command mv "$exe_file" "$exe_file.old"
            command mv "$timestamp_file" "$timestamp_file.old"
        end
    end

    if not test -f "$exe_file"
        command curl -s --location "$(_zellij_url)" | tar -C "$dir" -xz &>/dev/null
        command echo (date +%s) >"$timestamp_file"
    end

    if not test -f "$exe_file"
        if test -f "$exe_file.old"
            command mv "$exe_file.old" "$exe_file"
            command mv "$timestamp_file.old" "$timestamp_file"
        else
            echo "could not curl $(_zellij_url)"
            return 1
        end
    end

    command "$exe_file" $argv
end
