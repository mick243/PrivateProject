#!/usr/bin/env bash
# 프로세스별 메모리 — arcade-process-memory.timer 가 1분마다 돌리고, node_exporter 의 textfile 수집기가 내보낸다.
# install-monitoring.sh 가 /opt/arcade-monitoring/bin/process-memory 로 넣는다.
#
#   process-memory <출력 .prom 파일>
#
# 서버 전체 메모리(node_exporter)만으로는 누가 먹는지 알 수 없다 — 2026-10-07 15:19 에 스왑에 있던 150MB 가
# 한꺼번에 RAM 으로 올라왔는데, 어느 프로세스였는지 지표로는 가릴 수 없었다. 그래서 프로세스 이름과 그 프로세스가 속한
# systemd 서비스(unit)별로 더해 둔다. 앱은 실행기(node)와 본체(next-server) 둘이 arcade-finder 아래에,
# PostgreSQL 은 접속마다 생기는 postgres 여럿이 postgresql@18-main 아래에 모인다.
#
# 값은 /proc/<pid>/smaps_rollup 의 PSS 다. 여러 프로세스가 같이 쓰는 메모리(PostgreSQL 공유 버퍼 · 라이브러리)는
# 나눠 세므로 더해도 두 번 세지 않는다 — RSS 로 더하면 공유 버퍼를 PostgreSQL 프로세스 수만큼 센다.
#   ram   Pss_Anon + Pss_Shmem  힙 · 공유 메모리. 버릴 수 없어서 모자라면 스왑으로 내려간다
#   file  Pss_File              실행 파일 · 라이브러리 · 읽어 둔 파일. 모자라면 버렸다가 다시 읽는다
#   swap  SwapPss               스왑에 내려가 있는 양
# 다 합쳐 1MB 가 안 되는 것은 뺀다 — 잠깐 떴다 지는 명령이 시계열을 늘리지 않게.
set -uo pipefail
OUT="${1:?출력 파일을 주세요 (예: /var/lib/arcade-monitoring/textfile/processes.prom)}"

declare -A ram=() file=() swap=() count=()
for d in /proc/[0-9]*; do
  # 도는 사이에 끝난 프로세스는 파일이 없다 — 조용히 건너뛴다
  read -r name 2>/dev/null < "$d/comm" || continue
  p=0 a=0 f=0 sh=0 s=0 split=0
  while read -r k v _; do
    case "$k" in
      Pss:) p=$v ;;
      Pss_Anon:) a=$v; split=1 ;;
      Pss_File:) f=$v ;;
      Pss_Shmem:) sh=$v ;;
      SwapPss:) s=$v ;;
    esac
  done 2>/dev/null < "$d/smaps_rollup" || continue
  (( p + s > 0 )) || continue          # 커널 스레드는 비어 있다
  (( split )) || { a=$p; f=0; sh=0; }  # 5.9 전 커널은 Pss_Anon 이 없다 — 전부 ram 으로 센다

  # 이름 다듬기 — Node 24 는 프로세스 이름(comm)을 MainThread 로 바꾸므로 실행 파일 이름(node)으로,
  # Next 는 "next-server (v16.3.0)" 을 15자로 잘라 "next-server (v1" 이 되므로 괄호 앞까지만
  if [[ "$name" == MainThread ]]; then
    IFS= read -r -d '' argv0 2>/dev/null < "$d/cmdline" && [[ -n "$argv0" ]] && name="${argv0##*/}"
  fi
  name="${name%% (*}"
  # 서비스 — /proc/<pid>/cgroup 의 마지막 칸(arcade-finder.service 등). SSH 접속은 접속마다 번호가 바뀌어 하나로 묶는다.
  # 값에 빈칸을 두지 않는다 — 서버에서 `sort -k2` 로 줄 세울 때 칸이 밀린다
  unit=""
  read -r cg 2>/dev/null < "$d/cgroup" && unit="${cg##*/}"
  unit="${unit%.service}"
  case "$unit" in
    session-*.scope) unit="ssh-session" ;;
    init.scope) unit="systemd" ;;
    "") unit="-" ;;
  esac

  key="$name"$'\t'"$unit"
  ram[$key]=$(( ${ram[$key]:-0} + a + sh ))
  file[$key]=$(( ${file[$key]:-0} + f ))
  swap[$key]=$(( ${swap[$key]:-0} + s ))
  count[$key]=$(( ${count[$key]:-0} + 1 ))
done

# 라벨 값에서 \ 와 " 를 막는다 (comm 은 프로세스가 마음대로 바꿀 수 있다)
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }
labels() { printf 'name="%s",unit="%s"' "$(esc "${1%%$'\t'*}")" "$(esc "${1#*$'\t'}")"; }

umask 027   # 폴더가 setgid(arcade-monitor)라 node_exporter 가 읽는다
{
  echo '# HELP arcade_process_memory_bytes 프로세스 이름 · 서비스별 메모리 (PSS). type: ram 힙·공유 메모리 / file 파일 / swap 스왑'
  echo '# TYPE arcade_process_memory_bytes gauge'
  for k in "${!ram[@]}"; do
    (( ram[$k] + file[$k] + swap[$k] >= 1024 )) || continue
    l="$(labels "$k")"
    printf 'arcade_process_memory_bytes{%s,type="ram"} %d\n' "$l" $(( ram[$k] * 1024 ))
    printf 'arcade_process_memory_bytes{%s,type="file"} %d\n' "$l" $(( file[$k] * 1024 ))
    printf 'arcade_process_memory_bytes{%s,type="swap"} %d\n' "$l" $(( swap[$k] * 1024 ))
  done
  echo '# HELP arcade_process_count 프로세스 이름 · 서비스별 프로세스 수 (메모리 1MB 이상인 것만)'
  echo '# TYPE arcade_process_count gauge'
  for k in "${!ram[@]}"; do
    (( ram[$k] + file[$k] + swap[$k] >= 1024 )) || continue
    printf 'arcade_process_count{%s} %d\n' "$(labels "$k")" "${count[$k]}"
  done
} > "$OUT.tmp" && mv -f "$OUT.tmp" "$OUT"
