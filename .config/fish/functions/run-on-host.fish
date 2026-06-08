function run-on-host
    if set -q LUBOX_CONTAINER_NAME
        command lubox host-exec $argv
    else
        command $argv
    end
end
