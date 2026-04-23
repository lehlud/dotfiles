function _fastfetch_url --description "Get fastfetch download url"
    switch (uname -m)
        case x86_64
            set arch amd64
        case arm64 aarch64
            set arch aarch64
        case '*'
            echo "Unsupported cpu arch: "(uname -m)
            exit 2
    end

    switch (uname -s)
        case Linux
            set sys linux
        case '*'
            echo "Unsupported system: "(uname -s)
            set --erase arch
            exit 2
    end

    set --local url "https://github.com/fastfetch-cli/fastfetch/releases/latest/download/fastfetch-$sys-$arch.tar.gz"
    set --erase arch
    set --erase sys

    echo "$url"
end

function fastfetch --description "better than neofetch"
    set --local dir "$HOME/.local/cache/fastfetch"
    command mkdir -p "$dir"

    set --local download_dir "$dir/fastfetch-linux-amd64"
    set --local timestamp_file "$dir/timestamp"

    if not test -d "$download_dir"
        command rm -f "$timestamp_file"
    end

    if test -f "$timestamp_file"
        set --local ts (cat "$timestamp_file")
        set --local now (date +%s)
        set --local seven_days (math 7 \* 24 \* 60 \* 60)

        if test (math $now - $ts) -gt $seven_days
            command rm -rf "$download_dir"
            command mv "$download_dir" "$download_dir.old"
            command mv "$timestamp_file" "$timestamp_file.old"
        end
    end

    if not test -d "$download_dir"
        command curl --location "$(_fastfetch_url)" | tar -C "$dir" -xz
        command echo (date +%s) >"$timestamp_file"
    end

    if not test -d "$download_dir"
        if test -d "$download_dir.old"
            command mv "$download_dir.old" "$download_dir"
            command mv "$timestamp_file.old" "$timestamp_file"
        else
            echo "could not curl $(_fastfetch_url)"
            return 1
        end
    end

    command "$download_dir/usr/bin/fastfetch" $argv
end
