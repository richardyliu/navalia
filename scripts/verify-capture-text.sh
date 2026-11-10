#!/usr/bin/env bash
# P0-1 capture text health check (read-only).
#
# Prints, for the last 3 local days: captures / with_text / with_focused_value
# from index.db `captures`, and timeline_blocks counts by normalization_status.
# Counts only: never titles, URLs, text, tokens or paths inside the db.
#
# Usage: scripts/verify-capture-text.sh [--db PATH] [--today YYYY-MM-DD]
#   DB default: $PERSOME_ROOT/index.db, else ~/.persome/index.db
#   --today pins the latest day (tests); local dates use the process TZ.
# Exit: 0 normal (incl. missing db / empty tables), 2 when the latest day has
#       captures>0 and with_text==0, 1 on usage/sqlite errors.
set -euo pipefail

db=""
today=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) db="${2:-}"; shift 2 ;;
    --today) today="${2:-}"; shift 2 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$db" ]]; then
  root="${PERSOME_ROOT:-$HOME/.persome}"
  db="$root/index.db"
fi
if [[ -n "$today" && ! "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "--today must be YYYY-MM-DD" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found" >&2
  exit 1
fi

tz_name="${TZ:-$(date +%Z)}"
tz_offset="$(date +%z)"
[[ -z "$today" ]] && today="$(date +%Y-%m-%d)"

shown_db="$db"
[[ -n "${HOME:-}" && "$db" == "$HOME"/* ]] && shown_db="~${db#"$HOME"}"
echo "verify-capture-text: db=${shown_db}"
echo "timezone: ${tz_name} (UTC${tz_offset}); local dates; latest day=${today}"

if [[ ! -f "$db" ]]; then
  echo "空态: index.db not found"
  exit 0
fi

q() { sqlite3 -readonly -batch -noheader -separator '|' -- "$db" "$1"; }

has_table() {
  [[ "$(q "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$1';")" == "1" ]]
}
has_column() {
  [[ "$(q "SELECT count(*) FROM pragma_table_info('$1') WHERE name='$2';")" == "1" ]]
}

days=()
for back in 2 1 0; do
  days+=("$(q "SELECT date('${today}', '-${back} day');")")
done

latest_caps=0
latest_text=0
echo
echo "captures (local day | captures | with_text | with_focused_value)"
if has_table captures; then
  fv_expr="0"
  has_column captures focused_value && fv_expr="SUM(CASE WHEN length(trim(coalesce(focused_value,''))) > 0 THEN 1 ELSE 0 END)"
  vt_expr="0"
  has_column captures visible_text && vt_expr="SUM(CASE WHEN length(trim(coalesce(visible_text,''))) > 0 THEN 1 ELSE 0 END)"
  for d in "${days[@]}"; do
    row="$(q "SELECT count(*), coalesce(${vt_expr},0), coalesce(${fv_expr},0) FROM captures WHERE date(timestamp, 'localtime') = '${d}';")"
    IFS='|' read -r n t f <<<"$row"
    echo "${d} | ${n} | ${t} | ${f}"
    if [[ "$d" == "$today" ]]; then latest_caps=$n; latest_text=$t; fi
  done
else
  echo "空态: no captures table"
fi

echo
echo "timeline_blocks (local day | status | count)"
if has_table timeline_blocks; then
  status_col="normalization_status"
  has_column timeline_blocks status && status_col="status"
  if ! has_column timeline_blocks "$status_col"; then
    echo "空态: timeline_blocks has no status column"
  else
    any=0
    for d in "${days[@]}"; do
      rows="$(q "SELECT coalesce(${status_col},'(null)'), count(*) FROM timeline_blocks WHERE date(start_time, 'localtime') = '${d}' GROUP BY 1 ORDER BY 1;")"
      if [[ -z "$rows" ]]; then
        echo "${d} | (none) | 0"
      else
        any=1
        while IFS='|' read -r st c; do
          # Status is an enum (llm / llm_failed / metadata_only / ...); refuse anything else.
          [[ "$st" =~ ^[A-Za-z_()]{1,32}$ ]] || st="(other)"
          echo "${d} | ${st} | ${c}"
        done <<<"$rows"
      fi
    done
    [[ $any -eq 0 ]] && echo "空态: no timeline_blocks in window"
  fi
else
  echo "空态: no timeline_blocks table"
fi

echo
if [[ "$latest_caps" -gt 0 && "$latest_text" -eq 0 ]]; then
  echo "VERDICT: NO_TEXT — ${today}: ${latest_caps} captures, 0 with visible_text (check Accessibility / Screen Recording grants for Navalia)"
  exit 2
fi
echo "VERDICT: OK — ${today}: ${latest_caps} captures, ${latest_text} with visible_text"
exit 0
