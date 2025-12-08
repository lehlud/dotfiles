function run-on-host
    if set -q CONTAINER_ID
        command distrobox-host-exec $argv
    else
        command $argv
    end
end
