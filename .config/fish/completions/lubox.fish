# fish completions for lubox

function __fish_lubox_seen_command
    set -l tokens (commandline -opc)
    for token in $tokens[2..-1]
        switch $token
            case doctor list create destroy start stop enter exec code-server enable host-exec
                echo $token
                return 0
        end
    end
    return 1
end

function __fish_lubox_needs_command
    not __fish_lubox_seen_command >/dev/null
end

function __fish_lubox_using_command
    set -l command (__fish_lubox_seen_command)
    test "$command" = "$argv[1]"
end

function __fish_lubox_using_any_engine_command
    set -l command (__fish_lubox_seen_command)
    contains -- "$command" doctor list create destroy start stop enter exec code-server enable
end

function __fish_lubox_boxes
    command lubox __fish-complete boxes 2>/dev/null
end

function __fish_lubox_commands
    command lubox __fish-complete commands 2>/dev/null
end

function __fish_lubox_engines
    command lubox __fish-complete engines 2>/dev/null
end

complete -c lubox -f

complete -c lubox -f -n '__fish_lubox_needs_command' -a '(__fish_lubox_commands)'
complete -c lubox -f -s h -l help -d 'Show help'

complete -c lubox -f -n '__fish_lubox_using_any_engine_command' -l engine -r -a '(__fish_lubox_engines)' -d 'Container engine'

complete -c lubox -f -n '__fish_lubox_using_command create' -l image -r -d 'Base image'
complete -c lubox -f -n '__fish_lubox_using_command create' -l no-host-exec -d 'Disable host-exec bridge'
complete -c lubox -f -n '__fish_lubox_using_command create' -l rebuild -d 'Recreate existing container'

complete -c lubox -f -n '__fish_lubox_using_command enter' -l xquartz -d 'Enable XQuartz forwarding'

complete -c lubox -f -n '__fish_lubox_using_command destroy' -s f -l force -d 'Force removal and remove image'

complete -c lubox -f -n '__fish_lubox_using_command destroy' -a '(__fish_lubox_boxes)' -d 'Container'
complete -c lubox -f -n '__fish_lubox_using_command start' -a '(__fish_lubox_boxes)' -d 'Container'
complete -c lubox -f -n '__fish_lubox_using_command stop' -a '(__fish_lubox_boxes)' -d 'Container'
complete -c lubox -f -n '__fish_lubox_using_command enter' -a '(__fish_lubox_boxes)' -d 'Container'
complete -c lubox -f -n '__fish_lubox_using_command exec' -a '(__fish_lubox_boxes)' -d 'Container'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -a '(__fish_lubox_boxes)' -d 'Container'

complete -c lubox -f -n '__fish_lubox_using_command code-server' -l port -r -d 'Local browser port'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -l container-port -r -d 'Container code-server port'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -l host -d 'Listen on all host interfaces'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -l auth -r -a 'none password' -d 'Authentication mode'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -l password -r -d 'Password for auth'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -l no-open -d 'Do not open browser'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -l install-only -d 'Only install code-server'
complete -c lubox -f -n '__fish_lubox_using_command code-server' -l reinstall -d 'Reinstall latest code-server'

complete -c lubox -f -n '__fish_lubox_using_command enable' -a 'xquartz' -d 'Enable XQuartz forwarding'

complete -c lubox -f -n '__fish_lubox_using_command enter' -a '--' -d 'Run command'
complete -c lubox -f -n '__fish_lubox_using_command exec' -a '--' -d 'Run command'
