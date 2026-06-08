#!/usr/bin/env bash
set -euo pipefail

out="$HOME/.local/bin/cowsay"
source_cowsay=""

usage_generator() {
  cat <<'EOF'
Usage:
  make-cowsay.sh [-o OUTPUT] [--source COWSAY]

Creates a self-contained Bash cowsay script by using an installed cowsay to
pre-render embedded cow templates.

Options:
  -o OUTPUT        Output path. Default: $HOME/.local/bin/cowsay
  --source PATH    Source cowsay binary. Default: auto-detect real system cowsay
  -h, --help       Show this help

Examples:
  make-cowsay.sh
  make-cowsay.sh --source /usr/bin/cowsay
  make-cowsay.sh -o ~/.local/bin/cowsay --source /usr/bin/cowsay
EOF
}

while (($# > 0)); do
  case "$1" in
    -o)
      if [[ -z "${2:-}" ]]; then
        echo "error: -o requires an output path" >&2
        exit 2
      fi
      out="$2"
      shift 2
      ;;
    -o=*)
      out="${1#-o=}"
      shift
      ;;
    --source)
      if [[ -z "${2:-}" ]]; then
        echo "error: --source requires a cowsay path" >&2
        exit 2
      fi
      source_cowsay="$2"
      shift 2
      ;;
    --source=*)
      source_cowsay="${1#--source=}"
      shift
      ;;
    -h|--help)
      usage_generator
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage_generator >&2
      exit 2
      ;;
  esac
done

find_source_cowsay() {
  local candidate
  local out_real
  local candidate_real

  out_real="$(readlink -f "$out" 2>/dev/null || printf '%s\n' "$out")"

  if [[ -n "$source_cowsay" ]]; then
    if [[ ! -x "$source_cowsay" ]]; then
      echo "error: source cowsay is not executable: $source_cowsay" >&2
      exit 1
    fi
    printf '%s\n' "$source_cowsay"
    return
  fi

  # Prefer the system binary. This avoids recursively using the generated
  # ~/.local/bin/cowsay when ~/.local/bin is first in PATH.
  for candidate in \
    /usr/bin/cowsay \
    /usr/local/bin/cowsay \
    /bin/cowsay
  do
    if [[ -x "$candidate" ]]; then
      candidate_real="$(readlink -f "$candidate" 2>/dev/null || printf '%s\n' "$candidate")"
      if [[ "$candidate_real" != "$out_real" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    fi
  done

  # Fall back to PATH, but skip the output path.
  while IFS= read -r candidate; do
    [[ -x "$candidate" ]] || continue
    candidate_real="$(readlink -f "$candidate" 2>/dev/null || printf '%s\n' "$candidate")"

    if [[ "$candidate_real" != "$out_real" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done < <(type -aP cowsay 2>/dev/null | awk '!seen[$0]++')

  echo "error: could not find a source cowsay binary distinct from output path" >&2
  echo "hint: run with --source /usr/bin/cowsay" >&2
  exit 1
}

COWSAY_SRC="$(find_source_cowsay)"

if ! command -v gzip >/dev/null 2>&1; then
  echo "error: gzip is required" >&2
  exit 1
fi

if ! command -v base64 >/dev/null 2>&1; then
  echo "error: base64 is required" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cows_tsv="$tmp/cows.tsv"
: > "$cows_tsv"

mkdir -p "$(dirname "$out")"

list_cows() {
  "$COWSAY_SRC" -l |
    awk '
      NR == 1 && $0 ~ /^Cow files in / {
        next
      }

      {
        for (i = 1; i <= NF; i++) {
          print $i
        }
      }
    ' |
    sed 's/\.cow$//' |
    sort -u
}

strip_bubble() {
  # Simple and robust: cowsay output always has a bottom border made only from
  # spaces and dashes immediately before the cow art. We keep everything after
  # the last such border.
  awk '
    /^ -+$/ {
      last_border = NR
      next
    }

    {
      lines[NR] = $0
    }

    END {
      if (!last_border) {
        exit 1
      }

      for (i = last_border + 1; i <= NR; i++) {
        if (i in lines) {
          print lines[i]
        }
      }
    }
  '
}

encode_file() {
  local file="$1"

  gzip -9c "$file" | base64 | tr -d '\n'
  printf '\n'
}

count=0
default_cow=""

while IFS= read -r cow; do
  [[ -n "$cow" ]] || continue

  rendered="$tmp/rendered"
  art="$tmp/art"

  # Render with placeholder eyes/tongue. The generated standalone script
  # replaces these placeholders with runtime eyes/tongue.
  if ! printf '%s\n' 'x' |
      "$COWSAY_SRC" -n -W 999 -e '@@' -T '##' -f "$cow" > "$rendered" 2>/dev/null; then
    continue
  fi

  if ! strip_bubble < "$rendered" > "$art"; then
    continue
  fi

  if [[ ! -s "$art" ]]; then
    continue
  fi

  encoded="$(encode_file "$art")"
  printf '%s\t%s\n' "$cow" "$encoded" >> "$cows_tsv"

  count=$((count + 1))

  if [[ "$cow" == "default" ]]; then
    default_cow="default"
  fi
done < <(list_cows)

if ((count == 0)); then
  echo "error: no cows could be embedded" >&2
  echo "source cowsay: $COWSAY_SRC" >&2
  echo "debug: source cowsay -l output was:" >&2
  "$COWSAY_SRC" -l >&2 || true
  exit 1
fi

if [[ -z "$default_cow" ]]; then
  default_cow="$(awk -F '\t' 'NR == 1 { print $1 }' "$cows_tsv")"
fi

sed \
  -e "s/@COW_COUNT@/$count/g" \
  -e "s/@DEFAULT_COW@/$default_cow/g" \
  > "$out" <<'SCRIPT_HEAD'
#!/usr/bin/env bash
set -euo pipefail

COW_COUNT=@COW_COUNT@
DEFAULT_COW='@DEFAULT_COW@'
COW_MARKER="#__EMBEDDED_COWS_BELOW__"

eyes="oo"
tongue="  "
cow="$DEFAULT_COW"
wrap_column=40
nowrap=0
list_cows=0

usage() {
  cat <<'EOF'
cowsay compatible subset

Usage:
  cowsay [-bdgpstwy] [-e eyes] [-f cowfile] [-l] [-n] [-T tongue] [-W column] [message]

Supported options:
  -b              Borg mode
  -d              Dead mode
  -g              Greedy mode
  -p              Paranoid mode
  -s              Stoned mode
  -t              Tired mode
  -w              Wired mode
  -y              Youthful mode
  -e eyes         Set eyes, usually two characters
  -T tongue       Set tongue, usually two characters
  -f cowfile      Select cow by name
  -l              List embedded cows
  -n              Do not word-wrap
  -W column       Wrap column, default 40
  -h, --help      Show this help

Notes:
  Incoming tabs are converted to exactly four spaces before wrapping and
  bubble sizing.

Not implemented:
  Runtime Perl cowfile evaluation. Cow templates are embedded at generation time.
EOF
}

set_preset() {
  case "$1" in
    -b) eyes="=="; tongue="  " ;;
    -d) eyes="xx"; tongue="U " ;;
    -g) eyes='$$'; tongue="  " ;;
    -p) eyes="@@" ; tongue="  " ;;
    -s) eyes="**"; tongue="U " ;;
    -t) eyes="--"; tongue="  " ;;
    -w) eyes="OO"; tongue="  " ;;
    -y) eyes=".."; tongue="  " ;;
  esac
}

need_arg() {
  local opt="$1"
  local arg="${2:-}"

  if [[ -z "$arg" ]]; then
    echo "cowsay: option '$opt' requires an argument" >&2
    exit 2
  fi
}

while (($# > 0)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;

    -l)
      list_cows=1
      shift
      ;;

    -n)
      nowrap=1
      shift
      ;;

    -W)
      need_arg "-W" "${2:-}"
      wrap_column="$2"
      shift 2
      ;;

    -W[0-9]*)
      wrap_column="${1#-W}"
      shift
      ;;

    -e)
      need_arg "-e" "${2:-}"
      eyes="$2"
      shift 2
      ;;

    -e?*)
      eyes="${1#-e}"
      shift
      ;;

    -T)
      need_arg "-T" "${2:-}"
      tongue="$2"
      shift 2
      ;;

    -T?*)
      tongue="${1#-T}"
      shift
      ;;

    -f)
      need_arg "-f" "${2:-}"
      cow="$2"
      cow="${cow##*/}"
      cow="${cow%.cow}"
      shift 2
      ;;

    -f?*)
      cow="${1#-f}"
      cow="${cow##*/}"
      cow="${cow%.cow}"
      shift
      ;;

    -[bdgpstwy])
      set_preset "$1"
      shift
      ;;

    --)
      shift
      break
      ;;

    -*)
      echo "cowsay: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;

    *)
      break
      ;;
  esac
done

if ! [[ "$wrap_column" =~ ^[0-9]+$ ]] || ((wrap_column < 1)); then
  echo "cowsay: -W requires a positive integer" >&2
  exit 2
fi

# Cowsay is historically two-character oriented here. Normalize to exactly
# two characters so embedded templates remain stable.
eyes="${eyes:0:2}"
tongue="${tongue:0:2}"

while ((${#eyes} < 2)); do
  eyes="${eyes} "
done

while ((${#tongue} < 2)); do
  tongue="${tongue} "
done

decode_base64() {
  if printf '' | base64 -d >/dev/null 2>&1; then
    base64 -d
  else
    base64 -D
  fi
}

marker_line() {
  grep -anF "$COW_MARKER" "$0" |
    tail -n 1 |
    cut -d: -f1
}

cow_table() {
  local m_line

  m_line="$(marker_line)"

  if [[ -z "$m_line" ]]; then
    echo "cowsay: embedded cow section is corrupt" >&2
    exit 1
  fi

  awk -v start="$((m_line + 1))" '
    NR >= start
  ' "$0"
}

list_embedded_cows() {
  cow_table |
    awk -F '\t' '{ print $1 }' |
    sort |
    awk '
      BEGIN {
        print "Cow files in standalone cowsay:"
      }

      {
        next_piece = $0 " "

        if (length(line) + length(next_piece) > 72) {
          if (line != "") {
            print line
          }
          line = next_piece
        } else {
          line = line next_piece
        }
      }

      END {
        if (line != "") {
          print line
        }
      }
    '
}

encoded_cow() {
  local wanted="$1"

  cow_table |
    awk -F '\t' -v wanted="$wanted" '
      $1 == wanted {
        print $2
        found = 1
        exit
      }

      END {
        if (!found) {
          exit 2
        }
      }
    '
}

render_cow_art() {
  local encoded="$1"

  printf '%s' "$encoded" |
    decode_base64 |
    gzip -dc |
    while IFS= read -r line; do
      line="${line//@@/$eyes}"
      line="${line//##/$tongue}"
      printf '%s\n' "$line"
    done
}

read_message() {
  if (($# > 0)); then
    printf '%s\n' "$*"
  else
    cat
  fi
}

normalize_input_tabs() {
  # Deterministic width handling: replace every literal tab with exactly
  # four spaces before any wrapping or bubble width calculation.
  sed $'s/\t/    /g'
}

wrap_message() {
  if ((nowrap)); then
    cat
    return
  fi

  awk -v width="$wrap_column" '
    function emit_line(s) {
      print s
    }

    function wrap(s) {
      while (length(s) > width) {
        cut = width

        for (i = width; i >= 1; i--) {
          if (substr(s, i, 1) ~ /[[:space:]]/) {
            cut = i
            break
          }
        }

        part = substr(s, 1, cut)
        sub(/[[:space:]]+$/, "", part)

        if (part == "") {
          part = substr(s, 1, width)
          cut = width
        }

        emit_line(part)

        s = substr(s, cut + 1)
        sub(/^[[:space:]]+/, "", s)
      }

      emit_line(s)
    }

    {
      if ($0 == "") {
        print ""
      } else {
        wrap($0)
      }
    }
  '
}

make_bubble() {
  local lines_file="$1"
  local width
  local n
  local line
  local len
  local pad

  width="$(
    awk '
      {
        len = length($0)
        if (len > max) {
          max = len
        }
      }

      END {
        print max + 0
      }
    ' "$lines_file"
  )"

  n="$(wc -l < "$lines_file" | tr -d '[:space:]')"

  printf ' '
  printf '%*s' "$((width + 2))" '' | tr ' ' '_'
  printf '\n'

  if ((n <= 1)); then
    line="$(cat "$lines_file")"
    len="${#line}"
    pad="$((width - len))"
    printf '< %s%*s >\n' "$line" "$pad" ''
  else
    local i=0

    while IFS= read -r line; do
      i=$((i + 1))
      len="${#line}"
      pad="$((width - len))"

      if ((i == 1)); then
        printf '/ %s%*s \\\n' "$line" "$pad" ''
      elif ((i == n)); then
        printf '\\ %s%*s /\n' "$line" "$pad" ''
      else
        printf '| %s%*s |\n' "$line" "$pad" ''
      fi
    done < "$lines_file"
  fi

  printf ' '
  printf '%*s' "$((width + 2))" '' | tr ' ' '-'
  printf '\n'
}

if ((list_cows)); then
  list_embedded_cows
  exit 0
fi

if ! encoded="$(encoded_cow "$cow")"; then
  echo "cowsay: unknown cow: $cow" >&2
  echo >&2
  list_embedded_cows >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

message_file="$tmpdir/message"
lines_file="$tmpdir/lines"

read_message "$@" |
  normalize_input_tabs > "$message_file"

if [[ ! -s "$message_file" ]]; then
  printf '\n' > "$message_file"
fi

wrap_message < "$message_file" > "$lines_file"

make_bubble "$lines_file"
render_cow_art "$encoded"

exit 0

#__EMBEDDED_COWS_BELOW__
SCRIPT_HEAD

cat "$cows_tsv" >> "$out"

chmod +x "$out"

echo "Created: $out"
echo "Source cowsay: $COWSAY_SRC"
echo "Embedded cows: $count"
echo "Default cow: $default_cow"
echo
echo "Try it:"
echo "  $out hello"
echo "  $out -l"
echo "  $out -f tux hello"
echo "  fortune | $out"
