@echo off
rem 윈도우 작업 스케줄러가 부르는 자리 (매일 09:00).
rem
rem   schtasks /create /tn "arcade-finder-news" /tr "<이 파일의 전체 경로>" /sc daily /st 09:00
rem
rem 리눅스 서버라면 크론 한 줄로 같은 일을 합니다:
rem   0 9 * * *  cd /srv/arcade-finder && NODE_USE_SYSTEM_CA=1 /usr/bin/node scripts/sync-news.mjs >> logs/news-sync.log 2>&1
rem
rem ⚠ 이 파일은 CRLF 로 저장해야 합니다. LF 로 두면 cmd.exe 가 줄을 이어 읽어
rem   "')' was unexpected at this time" 으로 죽습니다 (.gitattributes 로 고정).
rem
rem 스크립트가 .env.local 을 process.cwd() 에서 찾으므로 프로젝트 폴더로 옮깁니다.
cd /d "%~dp0.."
if not exist logs mkdir logs

rem ⚠ piugame.com 은 중간 인증서를 보내지 않습니다 (체인에 잎사귀 한 장뿐).
rem    노드가 기본으로 들고 있는 CA 목록만으로는 검증이 안 돼
rem    UNABLE_TO_VERIFY_LEAF_SIGNATURE 로 죽습니다. 윈도우 인증서 저장소를
rem    쓰게 하면 중간 인증서를 채워 검증이 통과합니다. 검증을 끄는 것이 아니라
rem    (NODE_TLS_REJECT_UNAUTHORIZED=0 은 절대 쓰지 마세요) 믿을 곳을 OS 에
rem    맡기는 것입니다.
set NODE_USE_SYSTEM_CA=1

echo [%date% %time%] sync-news>>logs\news-sync.log
node scripts\sync-news.mjs>>logs\news-sync.log 2>&1
