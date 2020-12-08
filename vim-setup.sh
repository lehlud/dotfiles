# install curl
sudo pacman -S curl --noconfirm

# install vim
sudo pacman -S vim --noconfirm

# install nodejs for coc
sudo pacman -S nodejs --noconfirm

# setup vim-plug
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

# copy vimrc
cp vimrc ~/.vimrc

# source copied vimrc
vim -c source ~/.vimrc -c qa!
# install plugins
vim -c PlugInstall vimtex -c coc.nvim -c PlugInstall lightline.vim -c PlugInstall nerdtree -c qa!
#install coc plugins
vim -c CocInstall coc-python -c qa!
