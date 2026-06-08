function lubox --wraps lubox
    if test (count $argv) -ge 2; and test "$argv[1]" = enable; and test "$argv[2]" = xquartz; and set -q LUBOX_CONTAINER_NAME
        set -l output (command lubox enable xquartz --shell fish)
        set -l lubox_status $status
        if test $lubox_status -ne 0
            return $lubox_status
        end
        eval (string join '; ' $output)
        echo "lubox: enabled xquartz DISPLAY=$DISPLAY"
        return 0
    end

    command lubox $argv
end
