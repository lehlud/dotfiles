function envsource
    set -l envfile (string replace '~' $HOME $argv[1])
    if not test -f "$envfile"
        echo "File not found: $envfile"
        return 1
    end

    while read line
        # Skip comments and empty lines
        if string match -qr '^#|^$' "$line"
            continue
        end

        # Split on the first '=' only to handle values containing '='
        set item (string split -m 1 '=' "$line")
        if test (count $item) -eq 2
            set -gx $item[1] $item[2]
        end
    end < "$envfile"
end

