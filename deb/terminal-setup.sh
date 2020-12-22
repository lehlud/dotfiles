#!/bin/sh

# install alacritty
# sh alacritty-setup.sh

# FISH SETUP
sudo apt install -y fish curl
curl -L https://get.oh-my.fish | fish
mkdir -p $fish_complete_path[1]
cp extra/completions/alacritty.fish $fish_complete_path[1]/alacritty.fish

