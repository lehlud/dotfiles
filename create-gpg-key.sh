# install gpg
sudo pacman -S gpg --noconfirm

# generate key
tput setaf 2; echo "Please enter 1, then 4096!"; tput sgr0;
gpg --full-generate-key

