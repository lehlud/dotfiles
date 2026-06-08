function _venv_options
    set --local venvs
    for dir in ~/.venv/*
        if test -d $dir
            set venvs $venvs (basename $dir)
        end
    end

    echo $venvs
end

complete -c venv -f -n 'not __fish_seen_subcommand_from alpha beta gamma' -a "$(_venv_options)" -r
