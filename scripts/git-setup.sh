# install git
sudo pacman -S git --noconfirm

# setup keyring
sudo pacman -S libsecret --noconfirm
git config --global credential.helper /usr/lib/git-core/git-credential-libsecret

tput setaf 2; printf "Follow these steps to setup a GPG key for your git instance:\nhttps://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/telling-git-about-your-signing-key\n"

