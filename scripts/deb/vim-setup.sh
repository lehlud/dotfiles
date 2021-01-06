#!/bin/sh

# install curl
sudo apt install curl --assume-yes

# install vim
sudo apt install vim --assume-yes

# install nodejs and npm for coc
sudo apt install nodejs npm --assume-yes

# setup vim-plug
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

# copy vimrc
cp ../vimrc ~/.vimrc

# source copied vimrc
vim -c source ~/.vimrc -c qa!
# install plugins
vim -c PlugInstall vimtex -c coc.nvim -c PlugInstall lightline.vim -c PlugInstall nerdtree -c qa!
