#!/bin/sh

# install git
sudo apt install git --assume-yes

# setup keyring
sudo apt install libsecret-1-0 libsecret-1-dev --assume-yes
cd /usr/share/doc/git/contrib/credential/libsecret
sudo make
git config --global credential.helper /usr/share/doc/git/contrib/credential/libsecret/git-credential-libsecret

tput setaf 2; printf "Follow these steps to setup a GPG key for your git instance:\nhttps://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/telling-git-about-your-signing-key\n"

