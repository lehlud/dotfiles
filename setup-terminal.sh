# install dependencies
sudo pacman -S curl --noconfirm

# install alacritty
sudo pacman -S alacritty --noconfirm
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
cp ~/.oh-my-zsh/custom/themes/example.zsh-theme .oh-my-zsh/custom/themes/default.zsh-theme

