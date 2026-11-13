# 메뉴 수동 검증 기록 — 2026-11-13

> 이 문서는 최초 캡처 장애의 기록이다. 이후 우회 방식으로 실제 메뉴 검증을 진행했다. **최종 결과는 [메뉴 검증 결과](menu-audit-2026-11-13-results.md)**를 참조한다.

> 후속으로 확인된 결함 5건을 수정했다. [수정·테스트 결과](menu-fixes-validation-2026-11-13.md). `.qa` 증거 경로는 로컬 자료이며 Git에 포함하지 않는다.

## 결과

**미완료: 앱 실행 후 Windows 화면 캡처 실패로 메뉴 클릭 검증을 시작하지 못했다.** 메뉴 동작이나 응답 성능을 통과로 판정한 항목은 없다.

## 환경과 실행

- 검사 시각: 2026-11-13 09:55 KST
- 저장소 HEAD: `9d45f2af205a3d5be3af325a2f2be7fa448644a7`
- 실행 파일: `target/debug/hpharness-desktop.exe` (수정 시각 2026-11-13 07:40:37). 기존 빌드를 실행했으며 HEAD와의 일치 여부는 미검증.
- 백엔드: `packages/harness/dist/main.js` (수정 시각 09:15:40)
- 별도 데이터: `.qa/menu-audit/data`; 테스트 파일: `.qa/menu-audit/project/example.py`
- `HPH_ROOT`는 현재 저장소, `HPH_DATA_DIR`는 위 별도 데이터 경로로 설정.
- PowerShell Start-Process로 실행. 창 제목 `Harness`, PID 420, Windows Responding=True 확인.
- daemon 및 SQLite 파일 생성 확인. 이 사실만으로 백엔드 기능 정상 여부를 판단하지 않음.

## 차단 사항 B-001: 화면 조작 도구의 캡처 시간 초과

- 재현: 실행 → `sky.list_windows()`로 Harness 창 선택 → `get_window` → `activate_window` → `get_window_state(include_screenshot=true, include_text=true)`.
- 결과: `window capture timed out: timed out waiting on channel`.
- 창 목록을 다시 조회하고 창을 다시 선택한 뒤 1회 재시도했으나 동일 오류.
- 도구 호출 전체 소요 시간: 최초 약 5.8초, 재시도 약 5.6초. **앱 메뉴의 응답 시간이 아닌 캡처 도구 호출 시간**이다.
- 화면 이미지와 접근성 트리를 얻지 못했으므로 메뉴 클릭 0건.
- 원인 미확정: 캡처 도구/네이티브 렌더링/창 상태 등의 구분이 필요하다. 앱 정지 또는 성능 결함으로 단정할 근거는 없다.
- computer-use 스킬의 복구 지침에 따라 창 재선택 후 재시도 실패 시 화면 입력을 중단했다.

## 남은 검증 목록

아래는 소스에서 확인한 검증 대상이며, 실제 클릭 결과가 아니다. 전부 미검증이다.

| 영역 | 검증 대상 |
| --- | --- |
| 사이드바 | 접기/열기, 새 작업, 작업 검색, 응답 필요 |
| 프로젝트 | 추가, 로컬/SSH 입력, Docker 입력, 첫 작업 만들기, 프로젝트 펼치기/접기, 작업 선택 |
| 새 작업 | 제목, 실행 대상, 기준 디렉토리, 작업 만들기 |
| 파일 | 프로젝트/파일 전환, 폴더 탐색, 파일 열기, 이미지/지원하지 않는 문서 미리보기 |
| 대화 | 입력, 전송, 실행 중 중지, 응답 복사, 도구 결과 펼치기, 파일과 도구, 모델 설정 열기 |
| 레이아웃 | 대화/편집 전환, 코드 미리보기, 실행 패널 열기/닫기 |
| 편집 | 버퍼 선택, 저장, 코드 탐색, LSP 연결/완성/정의/참조/진단, 충돌 처리 |
| 터미널 | 열기, 입력, Ctrl+C, 특수키, 닫기 |
| 실행 패널 | 승인, 명령 실행, Git 변경 조회/상태/patch 스테이징, 도구 연결 RPC |
| 기억 | 검색, 추가, 확정, 삭제 |
| 설정 | Light/Dark/Solarized, 세 프로토콜, 연결 설정 저장, 전체 JSON 검증·저장 |
| 언어 서버 | preset, 명령/인자, 시작 |
| Core | 후보 경로, 실행 중 전환 선택, 검증 후 교체 |

후속 검증에서는 UI 전환과 로컬 조회가 2초를 넘거나, 작업이 10초 이상 피드백 없이 지속되는 경우 지연 후보로 기록하고 재측정한다. 모델/SSH/언어 서버 지연은 외부 의존성과 구분한다. 이번 실행에서는 이러한 측정을 하지 못했다.

## 작업 상태

제품 코드 수정 없음. 검증용 앱과 별도 데이터는 후속 조사용으로 남겨 두었다. 전체 메뉴 검증 완료를 주장하지 않는다.

## 추가 원인 진단 (09:58 KST)

- Harness의 `include_screenshot=false, include_text=true` 요청은 약 0.4초 만에 성공. 창 제목/시스템 메뉴/최소화/최대화/닫기 정보 반환.
- Raise 후 이미지 캡처는 같은 시간 초과 발생.
- 초기 실행의 Hidden 옵션 영향을 분리하기 위해 Normal 옵션으로 새 Harness 창 실행. 새 창에서도 약 5.4초 뒤 같은 캡처 오류 발생. Hidden만의 문제는 아님.
- 별도 앱인 Windows 파일 탐색기(`hpharnessv2` 창)에서도 같은 캡처 오류 발생. Harness에 한정된 실패가 아님.
- 앱 내장 `--smoke-report`로 별도 실행한 결과 `nativeWindowRendered=true`, `backendConnected=true`, 상태 `실행 서비스 연결됨`. `capture-diagnostic.png`(54,420 bytes) 생성 성공.
- 증거 파일: `.qa/menu-audit/capture-diagnostic.json`, `.qa/menu-audit/capture-diagnostic.png`.
- 결론: 외부 Windows 화면 캡처 경로에서 프레임 수신이 시간 제한 안에 완료되지 않는 현상. Harness 렌더링 자체 실패나 메뉴 응답 지연으로 볼 근거는 없음. 캡처 서비스 내부 원인(세션/그래픽/프레임 전달 등)은 아직 미확정.
