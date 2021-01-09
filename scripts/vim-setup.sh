#!/bin/sh

# install curl, vim and nodejs 
sudo pacman -S vim nodejs --noconfirm

# setup vim-plug
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

# copy vimrc
cp ../.vimrc ~/.vimrc

# source copied vimrc
vim -c source ~/.vimrc -c qa!
# install plugins
vim -c PlugInstall vimtex -c coc.nvim -c PlugInstall lightline.vim -c PlugInstall nerdtree -c qa!
