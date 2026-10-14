#!/usr/bin/env bash

native_runtime() {
    local bytes machine

    case "$(uname -m)" in
        x86_64)
            machine=3e
            ;;
        aarch64)
            machine=b7
            ;;
        *)
            return 1
            ;;
    esac

    [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ] || return 1

    # ELF64, little-endian, current version, System V/Linux ABI, EXEC/DYN,
    # and the machine used by this Linux sandbox. Never execute a probe.
    read -ra bytes <<< "$(od -An -v -t x1 -N64 -w64 -- "$1" 2>/dev/null)"
    [ "${#bytes[@]}" = 64 ] \
        && [ "${bytes[*]:0:7}" = '7f 45 4c 46 02 01 01' ] \
        && [[ "${bytes[7]}" = 00 || "${bytes[7]}" = 03 ]] \
        && [[ "${bytes[16]}" = 02 || "${bytes[16]}" = 03 ]] \
        && [ "${bytes[17]}" = 00 ] \
        && [ "${bytes[18]} ${bytes[19]}" = "$machine 00" ] \
        && [ "${bytes[*]:20:4}" = '01 00 00 00' ] \
        && [ "${bytes[52]} ${bytes[53]}" = '40 00' ]
}
