#!/bin/sh

# install vim, nodejs and npm (dependencies for coc.nvim)
sudo pacman -S vim nodejs npm --noconfirm

# setup vim-plug
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

# copy vimrc
cp ../.vimrc ~/.vimrc

# source copied vimrc
vim -c source ~/.vimrc -c qa!
# install plugins
vim -c PlugInstall -c qa!
