;; Ludwig Lehnert (c) 2021

(require 'package)
(add-to-list 'package-archives '("melpa" . "https://melpa.org/packages/") t)
(package-initialize)


(custom-set-variables
  '(custom-safe-themes
	 '("d14f3df28603e9517eb8fb7518b662d653b25b26e83bd8e129acea042b774298" default))
  '(dashboard-banner-logo-title "Welcome to Emacs Dashboard")
  '(dashboard-center-content t)
  '(dashboard-footer-messages nil)
  '(dashboard-items '((recents . 5) (bookmarks . 5) (registers . 5)))
  '(dashboard-startup-banner "~/.emacs.d/title.txt")
  '(global-display-line-numbers-mode t)
  ;; tabstop stuff
  '(indent-line-function 4)
  '(tab-width 4)
  '(c-basic-offset 4)
  '(lisp-indent-offset 2)
  '(sgml-basic-offset 4)
  '(nxml-child-indent 4)
  '(tab-stop-list (number-sequence 4 200 4))
  '(tab-width 4)
  ;; other stuff
  '(make-backup-files nil)
  '(menu-bar-mode nil)
  '(package-selected-packages
	 '(filetree auto-complete markdown-mode projectile dashboard pylint evil gruvbox-theme ##))
  '(scroll-bar-mode nil)
  '(tool-bar-mode nil)
  '(tooltip-mode nil))

(custom-set-faces
 ;; custom-set-faces was added by Custom.
 ;; If you edit it by hand, you could mess it up, so be careful.
 ;; Your init file should contain only one such instance.
 ;; If there is more than one, they won't work right.
 )

;; enable evil mode
(require 'evil)
(evil-mode 1)

;; load gruvbox theme
(load-theme 'gruvbox t)

;; set font size
(set-face-attribute 'default (selected-frame) :height 145)

;; start startup screen
(require 'dashboard)
(dashboard-setup-startup-hook)

;; define custom command
(defalias 'spg 'dashboard-refresh-buffer)

(ac-config-default)

