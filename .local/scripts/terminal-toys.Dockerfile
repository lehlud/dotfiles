FROM alpine:latest
RUN apk add --no-cache cmatrix sl ncurses-terminfo-base
USER 65534:65534
