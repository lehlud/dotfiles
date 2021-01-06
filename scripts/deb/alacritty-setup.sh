#!/bin/sh

# install dependencies
sudo apt install -y git cmake pkg-config libfreetype6-dev libfontconfig1-dev libxcb-xfixes0-dev python3
sudo snap install rustup

# install alacritty
cd ~/Downloads
git clone https://github.com/alacritty/alacritty.git
cd alacritty
rustup override set stable
rustup update stable

cargo build --release

# POST SETUP
# terminfo
sudo tic -xe alacritty,alacritty-direct extra/alacritty.info

# desktop entry
sudo cp target/release/alacritty /usr/local/bin
sudo cp extra/logo/alacritty-term.svg /usr/share/pixmaps/Alacritty.svg
sudo desktop-file-install extra/linux/Alacritty.desktop
sudo update-desktop-database

