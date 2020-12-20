#!/bin/sh

# install kitty
sudo apt install kitty --assume-yes

# copy kitty.conf
cp kitty.conf ~/.config/kitty/kitty.conf

# update default terminal
sudo update-alternatives --config x-terminal-emulator

