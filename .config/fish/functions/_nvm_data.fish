function _nvm_data
    printf "%s/%s-%s\n" $nvm_data (command uname -s) (command uname -m)
end
