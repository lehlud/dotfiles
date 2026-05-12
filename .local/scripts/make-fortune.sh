#!/usr/bin/env bash
set -euo pipefail

out="$HOME/.local/bin/fortune"

usage_generator() {
  cat <<'EOF'
Usage:
  make-fortune.sh [-o OUTPUT] [FORTUNE_DIR ...]

Creates a self-contained fortune script.

Options:
  -o OUTPUT   Output path. Default: $HOME/.local/bin/fortune
  -h          Show this help

Examples:
  make-fortune.sh
  make-fortune.sh /usr/share/games/fortune
  make-fortune.sh -o ~/.local/bin/fortune /usr/share/games/fortune
EOF
}

dirs_args=()

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
    -h|--help)
      usage_generator
      exit 0
      ;;
    --)
      shift
      while (($# > 0)); do
        dirs_args+=("$1")
        shift
      done
      ;;
    -*)
      echo "error: unknown generator option: $1" >&2
      usage_generator >&2
      exit 2
      ;;
    *)
      dirs_args+=("$1")
      shift
      ;;
  esac
done

if ! command -v fortune >/dev/null 2>&1; then
  echo "error: fortune-mod does not appear to be installed; 'fortune' not found" >&2
  exit 1
fi

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

records_b64="$tmp/records.b64"
categories_tsv="$tmp/categories.tsv"

: > "$records_b64"
: > "$categories_tsv"

declare -A seen_dirs=()
dirs=()

add_dir() {
  local d="$1"

  [[ -d "$d" ]] || return 0
  [[ -n "${seen_dirs[$d]:-}" ]] && return 0

  seen_dirs["$d"]=1
  dirs+=("$d")
}

if ((${#dirs_args[@]} > 0)); then
  for d in "${dirs_args[@]}"; do
    add_dir "$d"
  done
else
  while IFS= read -r d; do
    add_dir "$d"
  done < <(
    fortune -f 2>&1 |
      awk '{
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^\//) print $i
        }
      }'
  )

  add_dir /usr/share/games/fortunes
  add_dir /usr/local/share/games/fortunes
  add_dir /usr/share/games/fortune
  add_dir /usr/local/share/games/fortune
  add_dir /usr/share/fortune
  add_dir /usr/local/share/fortune
fi

if ((${#dirs[@]} == 0)); then
  echo "error: could not find any fortune directories" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"

count=0
found_files=0
found_categories=0

encode_one_fortune() {
  local src="$1"

  gzip -9c "$src" | base64 | tr -d '\n'
  printf '\n'
}

normalize_category_name() {
  local name="$1"

  name="${name%/}"
  name="${name##*/}"

  printf '%s\n' "$name"
}

process_fortune_file() {
  local file="$1"
  local category="$2"
  local split_dir="$3"
  local before after start end record

  rm -rf "$split_dir"
  mkdir -p "$split_dir"

  awk -v dir="$split_dir" '
    function trim(s) {
      gsub(/^[[:space:]\n\r]+/, "", s)
      gsub(/[[:space:]\n\r]+$/, "", s)
      return s
    }

    function flush() {
      rec = trim(buf)

      if (rec != "") {
        n++
        path = sprintf("%s/%08d", dir, n)
        print rec > path
        close(path)
      }

      buf = ""
    }

    $0 == "%" {
      flush()
      next
    }

    {
      if (buf == "") {
        buf = $0
      } else {
        buf = buf "\n" $0
      }
    }

    END {
      flush()
    }
  ' "$file"

  before="$count"
  start=$((count + 1))

  while IFS= read -r -d '' record; do
    [[ -s "$record" ]] || continue

    encode_one_fortune "$record" >> "$records_b64"
    count=$((count + 1))
  done < <(
    find "$split_dir" -type f -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' -print0 |
      sort -z
  )

  after="$count"

  if ((after > before)); then
    end="$after"
    printf '%s\t%s\t%s\n' "$category" "$start" "$end" >> "$categories_tsv"
    found_files=$((found_files + 1))
    found_categories=$((found_categories + 1))
  fi
}

while IFS= read -r -d '' file; do
  [[ "$file" == *.dat ]] && continue
  [[ "$file" == *.u8 ]] && continue
  [[ -r "$file" ]] || continue

  grep -Iq . "$file" || continue

  category="$(normalize_category_name "$file")"
  [[ -z "$category" ]] && continue

  process_fortune_file "$file" "$category" "$tmp/split_$found_files"
done < <(
  find "${dirs[@]}" -type f -print0 2>/dev/null |
    sort -z
)

if ((count == 0)); then
  echo "error: no fortunes extracted" >&2
  exit 1
fi

sed "s/@FORTUNE_COUNT@/$count/g" > "$out" <<'SCRIPT_HEAD'
#!/usr/bin/env bash
set -euo pipefail

FORTUNE_COUNT=@FORTUNE_COUNT@
DEFAULT_SHORT_MAX_CHARS=160
SHORT_RETRY_LIMIT=100

CATEGORY_MARKER="#__EMBEDDED_FORTUNE_CATEGORIES_BELOW__"
DATA_MARKER="#__EMBEDDED_FORTUNE_DATA_BELOW__"

usage() {
  cat <<'EOF'
fortune-mod compatible subset

Usage:
  fortune [-s] [-n number] [file/directory/all]
  fortune --list-categories

Supported options:
  -s                  Print only short fortunes, retrying until one is found
  -n number           Maximum character count for -s mode
  -h, --help          Show this help

Supported operands:
  all                 Use all embedded categories
  file/directory      Select an embedded category by basename

Extension:
  --list-categories   List embedded categories

Recognized but not implemented:
  -a -f -i -l -m -o -w
EOF
}

category="all"
short_mode=0
max_chars="$DEFAULT_SHORT_MAX_CHARS"
list_categories=0

unsupported_option() {
  echo "fortune: option '$1' is recognized but not implemented by this standalone script" >&2
  exit 2
}

need_arg() {
  local opt="$1"
  local arg="${2:-}"

  if [[ -z "$arg" ]]; then
    echo "fortune: option '$opt' requires an argument" >&2
    exit 2
  fi
}

normalize_category_arg() {
  local arg="$1"

  arg="${arg%/}"
  arg="${arg##*/}"

  if [[ -z "$arg" ]]; then
    arg="all"
  fi

  printf '%s\n' "$arg"
}

while (($# > 0)); do
  case "$1" in
    --list-categories)
      list_categories=1
      shift
      ;;

    --help)
      usage
      exit 0
      ;;

    -h)
      usage
      exit 0
      ;;

    -s)
      short_mode=1
      shift
      ;;

    -n)
      need_arg "-n" "${2:-}"
      max_chars="$2"
      shift 2
      ;;

    -n[0-9]*)
      max_chars="${1#-n}"
      shift
      ;;

    -m)
      need_arg "-m" "${2:-}"
      unsupported_option "-m"
      ;;

    -m*)
      unsupported_option "-m"
      ;;

    -[afilow])
      unsupported_option "$1"
      ;;

    -[afilow]*)
      unsupported_option "$1"
      ;;

    --)
      shift
      break
      ;;

    -*)
      echo "fortune: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;

    *)
      if [[ "$category" != "all" ]]; then
        echo "fortune: only one file/directory/all operand is supported" >&2
        exit 2
      fi

      category="$(normalize_category_arg "$1")"
      shift
      ;;
  esac
done

if (($# > 0)); then
  if [[ "$category" != "all" ]]; then
    echo "fortune: only one file/directory/all operand is supported" >&2
    exit 2
  fi

  category="$(normalize_category_arg "$1")"
  shift
fi

if (($# > 0)); then
  echo "fortune: only one file/directory/all operand is supported" >&2
  exit 2
fi

if ! [[ "$max_chars" =~ ^[0-9]+$ ]] || ((max_chars < 1)); then
  echo "fortune: -n requires a positive integer" >&2
  exit 2
fi

decode_base64() {
  if printf '' | base64 -d >/dev/null 2>&1; then
    base64 -d
  else
    base64 -D
  fi
}

marker_line() {
  local marker="$1"

  grep -anF "$marker" "$0" |
    tail -n 1 |
    cut -d: -f1
}

categories_block() {
  local c_line d_line

  c_line="$(marker_line "$CATEGORY_MARKER")"
  d_line="$(marker_line "$DATA_MARKER")"

  if [[ -z "$c_line" || -z "$d_line" || "$c_line" -ge "$d_line" ]]; then
    echo "fortune: embedded category section is corrupt" >&2
    exit 1
  fi

  awk -v start="$((c_line + 1))" -v end="$((d_line - 1))" '
    NR >= start && NR <= end
  ' "$0"
}

data_line() {
  local line_no="$1"
  local d_line target

  d_line="$(marker_line "$DATA_MARKER")"

  if [[ -z "$d_line" ]]; then
    echo "fortune: embedded data section is corrupt" >&2
    exit 1
  fi

  target="$((d_line + line_no))"

  awk -v target="$target" '
    NR == target {
      print
      exit
    }
  ' "$0"
}

list_embedded_categories() {
  categories_block |
    awk -F '\t' '{ print $1 }' |
    sort -u
}

category_ranges() {
  local wanted="$1"

  if [[ "$wanted" == "all" ]]; then
    printf '1 %s\n' "$FORTUNE_COUNT"
    return 0
  fi

  categories_block |
    awk -F '\t' -v wanted="$wanted" '
      $1 == wanted {
        print $2, $3
      }
    '
}

random_u32() {
  local n

  if command -v od >/dev/null 2>&1 && [[ -r /dev/urandom ]]; then
    n="$(od -An -N4 -tu4 /dev/urandom | tr -d '[:space:]')"
    printf '%d\n' "$n"
  else
    printf '%d\n' "$(( (RANDOM << 17) ^ (RANDOM << 2) ^ RANDOM ))"
  fi
}

rand_between() {
  local lo="$1"
  local hi="$2"
  local span n

  span="$((hi - lo + 1))"
  n="$(random_u32)"

  printf '%d\n' "$((n % span + lo))"
}

pick_from_ranges() {
  local ranges="$1"
  local total r

  total="$(
    printf '%s\n' "$ranges" |
      awk '{ total += $2 - $1 + 1 } END { print total + 0 }'
  )"

  if ((total <= 0)); then
    return 2
  fi

  r="$(rand_between 1 "$total")"

  printf '%s\n' "$ranges" |
    awk -v r="$r" '
      {
        width = $2 - $1 + 1

        if (r <= width) {
          print $1 + r - 1
          exit
        }

        r -= width
      }
    '
}

pick_line_number() {
  local ranges

  ranges="$(category_ranges "$category")"

  if [[ -z "$ranges" ]]; then
    return 2
  fi

  pick_from_ranges "$ranges"
}

decode_fortune_line() {
  local encoded="$1"

  printf '%s' "$encoded" | decode_base64 | gzip -dc
}

fortune_length() {
  wc -m | tr -d '[:space:]'
}

if ((list_categories)); then
  list_embedded_categories
  exit 0
fi

if [[ "$category" != "all" ]]; then
  if ! category_ranges "$category" | grep -q .; then
    echo "fortune: no fortunes found for category: $category" >&2
    echo >&2
    echo "available categories:" >&2
    list_embedded_categories >&2
    exit 1
  fi
fi

attempt=1

while :; do
  if ! pick="$(pick_line_number)"; then
    echo "fortune: failed to select a fortune" >&2
    exit 1
  fi

  encoded="$(data_line "$pick")"

  if [[ -z "$encoded" ]]; then
    echo "fortune: failed to read embedded fortune" >&2
    exit 1
  fi

  fortune_text="$(decode_fortune_line "$encoded")"

  if ((short_mode == 0)); then
    printf '%s\n' "$fortune_text"
    exit 0
  fi

  len="$(printf '%s' "$fortune_text" | fortune_length)"

  if ((len <= max_chars)); then
    printf '%s\n' "$fortune_text"
    exit 0
  fi

  if ((attempt >= SHORT_RETRY_LIMIT)); then
    printf '%s\n' "$fortune_text"
    exit 0
  fi

  attempt="$((attempt + 1))"
done

exit 0

#__EMBEDDED_FORTUNE_CATEGORIES_BELOW__
SCRIPT_HEAD

cat "$categories_tsv" >> "$out"

cat >> "$out" <<'SCRIPT_MIDDLE'
#__EMBEDDED_FORTUNE_DATA_BELOW__
SCRIPT_MIDDLE

cat "$records_b64" >> "$out"

chmod +x "$out"

echo "Created: $out"
echo "Embedded fortune files: $found_files"
echo "Embedded category ranges: $found_categories"
echo "Embedded fortunes: $count"
echo
echo "Try it:"
echo "  $out -h"
echo "  $out --list-categories"
echo "  $out -s"
echo "  $out -s -n 120 computers"
