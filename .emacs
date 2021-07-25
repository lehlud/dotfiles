;; Ludwig Lehnert (c) 2021

(require 'package)
(add-to-list 'package-archives '("melpa" . "https://melpa.org/packages/") t)
(package-initialize)


(custom-set-variables
 ;; custom-set-variables was added by Custom.
 ;; If you edit it by hand, you could mess it up, so be careful.
 ;; Your init file should contain only one such instance.
 ;; If there is more than one, they won't work right.
 '(global-display-line-numbers-mode t)
 '(make-backup-files nil)
 '(menu-bar-mode nil)
 '(package-selected-packages
   '(auto-complete format-all evil projectile doom-modeline dashboard atom-dark-theme))
 '(scroll-bar-mode nil)
 '(tool-bar-mode nil)
 '(tooltip-mode nil))

(custom-set-faces
 ;; custom-set-faces was added by Custom.
 ;; If you edit it by hand, you could mess it up, so be careful.
 ;; Your init file should contain only one such instance.
 ;; If there is more than one, they won't work right.
 )

;; setup auto-complete
(require 'auto-complete)
(ac-config-default)

;; enable evil mode
(require 'evil)
(evil-mode 1)

;; load gruvbox theme
(load-theme 'atom-dark t)

;; set font size
(set-face-attribute 'default (selected-frame) :height 145)

;; highlight current line
(global-hl-line-mode +1)

;; setup doom-modeline
(require 'doom-modeline)
(doom-modeline-mode 1)

;; asdf
(require 'projectile)
(projectile-mode +1)

;; setup dashboard
(require 'dashboard)
(setq dashboard-startup-banner "~/.emacs.d/title.txt")
;;(setq dashboard-items '((recents . 5) (bookmarks . 5)))
(dashboard-setup-startup-hook)

;; define custom commands
(defalias 'spg 'dashboard-refresh-buffer)
(defalias 'sc 'shell-command) 

