function venv --description "activate the given venv"
    set --local venvs
    for dir in ~/.venv/*
        if test -d $dir
            set venvs $venvs (basename $dir)
        end
    end

    if test (count $argv) -ne 1; or not contains $argv[1] $venvs
        echo "usage: venv <$(string join '|' $venvs)>"
        return 1
    end

    source "$HOME/.venv/$argv[1]/bin/activate.fish"
end
