# 메뉴 실행 검증 결과 — 2026-11-13

> **후속 상태:** 아래 F-01~F-05는 수정 및 재검증을 완료했다. [수정·테스트 결과](menu-fixes-validation-2026-11-13.md)를 참조한다. 이 문서는 수정 전 발견 기록을 보존하며 `.qa` 증거 링크는 로컬 워크스페이스 전용이다.

## 결과

외부 Windows 캡처 장애를 우회해 별도 네이티브 검증 빌드로 검사를 진행했다. **286개 입력/관찰 작업, 포인터 클릭 204회. 재현 가능한 기능 결함 5건**을 확인했다. 제품 소스는 수정하지 않았다.

아래 표에 명시한 로컬 메뉴와 조건부 승인·충돌 경로를 검사했다. 모든 원격 연동, 화면 크기, 입력 장치, 오류 조합까지 통과했다는 뜻은 아니다.

## 환경과 방법

- 2026-11-13 09:54~10:33 KST. HEAD `9d45f2af205a3d5be3af325a2f2be7fa448644a7`.
- 기존 실행 파일의 외부 캡처가 실패해 `crates/desktop/src`를 `.qa/menu-audit/native/src`에 복사하고 검증 드라이버만 추가했다. 별도 실행 파일은 `target/debug/hpharness-menu-audit.exe`.
- `eframe::App::raw_input_hook`으로 포인터 누름/놓기, 텍스트, 키, 스크롤 이벤트를 전달했다. 메뉴 핸들러 직접 호출이나 성공 상태 주입 없이 정상 UI의 `clicked()` 처리와 실제 RPC를 사용했다.
- 앱 렌더러의 스크린샷, 그려진 텍스트 좌표, 앱 상태를 기록했다. 디스크 파일·Git index·클립보드·서비스 조회로 결과를 교차 확인했다.
- 별도 데이터/프로젝트: `.qa/menu-audit/data`, `.qa/menu-audit/project`. 테스트 Git 저장소와 파일만 변경했다. 단, eframe UI 환경설정 저장소는 별도로 격리하지 않았으므로 창 배치 등 UI 선호 설정에 검증 흔적이 남을 수 있다.
- [이벤트 로그](../.qa/menu-audit/evidence/actions.jsonl), [드라이버](../.qa/menu-audit/driver.mjs), [네이티브 계측 코드](../.qa/menu-audit/native/src/audit.rs), [RPC 확인 도구](../.qa/menu-audit/rpc-probe.mjs).
- `NNNN.json`은 초기 관찰, `NNNN-settled.json`은 후속 관찰, `NNNN.png`는 해당 입력 이후 화면이다. 일부 초기 PNG는 애니메이션/로딩 중이므로 완료 판정에 후속 상태를 함께 사용했다.

## 재현 가능한 결함

### F-01 — 일반 설정과 고급 JSON 불일치로 설정이 되돌아감 (높음)

**재현:** 설정 → 프로토콜 `anthropic` → 연결 설정 저장 → 전체 설정(JSON) 확인 → 수정 없이 전체 설정 검증·저장.

**실제:** JSON에는 이전 `responses`가 남는다. 고급 JSON 저장 후 서비스 설정이 `responses`로 되돌아가지만 일반 선택란은 여전히 `anthropic`을 표시한다. 이후 요청에 쓰이는 설정과 화면이 다르다.

**기대:** 두 편집 방식의 값이 일치하거나 변경 충돌을 알려야 한다.

**증거:** [255 상태](../.qa/menu-audit/evidence/0255-settled.json), [258 화면](../.qa/menu-audit/evidence/0258.png). `settings.get`으로 저장 전 `anthropic`, 저장 후 `responses`를 확인했다. 최종적으로 화면과 서비스를 모두 `responses`로 복원했다.

**코드 근거:** `main.rs:1329`는 `self.settings`만 갱신하고 `advanced_settings`를 갱신하지 않는다. `main.rs:1330`의 고급 저장 후 일반 필드도 갱신되지 않는다. `Pending::Generic`의 refresh에 settings.get이 없다.

### F-02 — 정의 탐색 시 같은 파일이 중복 버퍼/탭으로 열림 (높음)

**재현:** 파일 목록에서 `example.py` 열기 → `greet` 사용 위치에서 코드 탐색/정의 → 언어 분석 결과 클릭.

**실제:** 같은 세션에 `example.py`와 `f:\works-agents\hpharnessv2\.qa\menu-audit\project\example.py`가 별도 버퍼로 존재하며 동명 탭 두 개가 생긴다.

**영향:** 동일 파일에 서로 다른 미저장 편집을 만들 수 있고 최신 내용을 혼동한다. 이번 검사에서 실제 데이터 손실은 관찰되지 않았고 외부 변경 저장 차단은 통과했다.

**기대:** 정규화된 파일 식별자로 기존 버퍼를 선택해야 한다.

**증거:** [158 화면](../.qa/menu-audit/evidence/0158.png), [버퍼 경로](../.qa/menu-audit/evidence/0158-settled.json). `main.rs:561` 이후 버퍼 검색은 경로 문자열을 그대로 비교하고 `open_location`은 LSP URI를 절대 경로로 변환한다.

### F-03 — 관리형 Pyright 설치를 preset 선택이 무시함 (중간)

**재현:** 자동 설정된 `node` + `.tools/languages/node_modules/pyright/langserver.index.js --stdio`로 연결 성공 → 서버 preset `pyright` 선택 → 언어 서버 시작.

**실제:** `ENOENT: spawn pyright-langserver ENOENT`, `lspReady=false`. 관리형 node 경로와 인자를 다시 입력하면 정상 연결된다. Pyright 패키지가 없는 환경에서만 생긴 실패가 아니다. 이 환경에는 전역 PATH의 `pyright-langserver` 명령이 없다.

**기대:** 이미 탐지한 관리형 설치를 preset에서도 사용하거나 별도 PATH 설치 필요를 알려야 한다.

**증거:** 초기 성공 54, [실패 267](../.qa/menu-audit/evidence/0267-settled.json), [복원 성공 274](../.qa/menu-audit/evidence/0274-settled.json). 관리형 탐지는 `main.rs:334`, preset 덮어쓰기는 `main.rs:1333`.

### F-04 — 도구가 생성한 파일이 현재 목록에 자동 반영되지 않음 (중간)

**재현:** 파일 목록을 연 상태에서 모델에 `qa-approval.txt` 생성 요청 → 이번 실행 허용 → 성공 응답과 실제 파일 확인.

**실제:** 파일 내용은 `QA_APPROVAL_OK`지만 현재 파일 목록에는 수 분간 나타나지 않았다. 프로젝트 루트에서 `상위 폴더`를 눌러 다시 조회한 후 나타났다.

**기대:** 도구 완료/주기적 조회로 갱신하거나 명시적인 새로고침을 제공해야 한다.

**증거:** 생성 188, [재조회 전 207](../.qa/menu-audit/evidence/0207-settled.json), [재조회 후 215](../.qa/menu-audit/evidence/0215-settled.json). `main.rs:402` refresh에는 열린 파일 내용 조회만 있고 files.list가 없다.

### F-05 — 성공·충돌 해소 후에도 이전 오류가 상태줄에 남음 (중간)

**재현:** 명령 실행에 잘못된 JSON 입력 → 오류 → 올바른 node argv JSON 실행.

**실제:** exitCode=0, status=completed, stdout=`QA_COMMAND_OK`인데 상태줄은 계속 `명령은 비어 있지 않은 문자열 JSON 배열이어야 합니다.`를 표시한다. 파일 충돌에서 `내 편집 복사 후 디스크 내용 사용`으로 해소해도 `VERSION_CONFLICT`가 남는다.

**기대:** 현재 완료/해소 상태로 갱신해야 한다.

**증거:** [116](../.qa/menu-audit/evidence/0116-settled.json), [214](../.qa/menu-audit/evidence/0214-settled.json). `main.rs:592`의 Pending::Command는 출력만 추가하고 status를 갱신하지 않는다. 충돌 해결 버튼도 buffer만 변경한다.

## 추가 관찰 및 구현 제한

- **빈 입력란 식별 어려움:** Light 테마의 기억 검색창·설정 빈 입력란이 배경과 거의 구분되지 않는다. 입력 자체는 성공했다. [기억 화면](../.qa/menu-audit/evidence/0082.png). 기능 불능과 구분한 사용성 관찰이다.
- **설정창 스크롤 이동:** 테마 변경과 일부 버튼 조작 후 스크롤 위치가 바뀌었다(26, 28, 40, 47). 계측 빌드의 프레임 지연·포커스 자동 스크롤 영향을 분리하지 못해 제품 결함으로 확정하지 않았다.
- **Office/PDF 미리보기 미구현:** PDF 클릭 시 명시적인 미지원 안내가 나왔다(160). 안내 동작은 정상이나 문서 미리보기 기능은 제공되지 않는다. 실제 PDF 파싱/Office/DRM 성공으로 판정하지 않았다.
- **외부 캡처 장애:** 기존/일반 표시 Harness와 Windows 탐색기 모두 약 5초 후 `window capture timed out: timed out waiting on channel`. 이미지 없는 창 정보 조회와 앱 자체 캡처는 성공했다. 앱 메뉴 성능 결함으로 계산하지 않았다. [초기 진단 기록](menu-audit-2026-11-13.md).

## 메뉴별 확인 결과

| 영역 | 실제 검사한 동작 | 결과/한계 |
| --- | --- | --- |
| 사이드바 | 접기/열기, 새 작업, 작업 검색/불일치, 응답 필요 | 정상 |
| 프로젝트 | 중앙 추가 버튼, + 아이콘, 로컬 생성, 첫 작업, 펼침/접기, 잘못된 경로 | 생성·오류 반환 정상 |
| 원격 입력 | SSH 체크, Host·Docker 입력 표시, 로컬 복원 | 입력 UI 확인. 실제 SSH/Docker 연결은 미검증 |
| 작업 | 제목 입력, 만들기, 기존 작업 간 전환, 대화 분리 | 정상 |
| 파일 탐색 | 프로젝트/파일 전환, 하위/상위 폴더, 텍스트·코드 열기 | 정상. 자동 갱신 F-04 |
| 배치 | 대화/편집, 실행 패널, 코드 미리보기 토글 | 정상. 여러 해상도/DPI는 미검증 |
| 대화 | 세 추천 프롬프트, 입력, 보내기, Ctrl+Enter, 렌더링, 복사, +, 모델 버튼 | 정상. 클립보드가 QA_CHAT_OK인지 확인 |
| 모델 | 세 프로토콜 저장 후 실제 단순 요청 | Responses/Chat Completions/Anthropic 모두 기대 응답 |
| 승인 | 실제 쓰기 요청, 상세 스크롤, 허용, 거절, 도구 결과 펼치기 | 허용 파일 생성, 거절 파일 미생성 확인 |
| 실행 제어 | 현재 작업 중지, 실행 작업 목록 | cancelled 확인. 다중 큐 전체 시나리오는 미검증 |
| 편집 | 여러 버퍼, 미저장 내용 유지, 저장 버튼, Ctrl+S, 원본 분할 | 실제 디스크 내용과 버전 확인 |
| 충돌 | 외부 수정 후 저장 차단, 내 편집 유지/재저장, 복사 후 디스크 사용 | 정상. 복사된 미저장 내용도 확인 |
| LSP | 자동완성 호출/선택 적용, 정의/결과 이동, 참조, 진단 | 실제 Pyright 응답. 정의 이동 F-02 |
| 미리보기 | PNG 열기/닫기, PDF 안내 열기/닫기 | PNG 정상, PDF 미구현 |
| 명령 실행 | JSON 오류와 정상 argv 실행 | stdout/exitCode 정상. 상태줄 F-05 |
| 터미널 | 실제 PowerShell PTY 열기, Ctrl+C, ↑/↓, Tab, Esc, 빈 입력 전송, 닫기 | UI 제어 확인. 임의 명령 전반을 검증한 것은 아님 |
| Git | 상태, 변경 조회, patch 스테이징 | 테스트 저장소 index에 실제 1줄 staged 변경 확인 |
| 도구 연결 | 기본 runs.status, method를 ping으로 변경해 실행 | 실제 RPC 수신. 모든 임의 RPC/업무 연동은 미검증 |
| 기억 | 추가, 검색 불일치/일치, 확정, 삭제 | confirmed=1 및 삭제 후 빈 목록 확인 |
| 테마 | Light, Dark, Solarized Light | 전환 정상. 스크롤은 미확정 관찰 |
| 설정 | 연결 저장, 고급 펼침, 잘못된 JSON 거부, 전체 저장 | 오류 처리 정상, 동기화 F-01 |
| LSP preset | pyright, clangd, cmake, typescript, rust-analyzer, kotlin, jdtls, groovy 각각 선택 | 값 반영 확인. 실제 분석은 관리형 Pyright만. preset F-03 |
| Core | 기본 재로드, 실행 중 전환 체크, 없는 후보 경로 오류, 기본 복원 | 정상. 실제 진행 중 작업 migration은 미검증 |

조건부 `언어 서버 연결` 바로가기와 모든 LSP 결과 항목·오류 조합까지 각각 클릭한 것은 아니다. 위 표의 메뉴 진입과 명시된 기능 경로를 검사했다.

## 응답 시간

| 구간 | 측정 | 해석 |
| --- | --- | --- |
| 입력→상태 확인 | 286회, 최소 51ms / 평균 약 407ms / 최대 947ms | 프레임 대기·상태 직렬화·PNG 저장 비용 포함. 순수 제품 클릭 지연이 아님 |
| Responses | 1.020초 | 사용자 메시지 01:17:41.663Z → assistant 01:17:42.683Z |
| Chat Completions | 약 1.504초 | run 생성 01:25:10.427Z → assistant 01:25:11.931Z |
| Anthropic | 약 1.828초 | run 생성 01:25:38.881Z → assistant 01:25:40.709Z |
| 외부 캡처 | 약 5.4~5.8초 후 실패 | 별도 도구 장애 |

검사한 일반 로컬 메뉴에서 2초 이상 입력 확인 지연이나 영구 멈춤은 관찰하지 않았다. pending이 남은 초기 화면은 완료로 취급하지 않고 후속 결과를 확인했다. 승인 대기 시간은 제외했다. 대용량 파일·장시간 실행·네트워크 장애·원격 성능은 미검증이다.

## 보조 검증 및 남긴 상태

- `cargo test -p hpharness-desktop --offline`: **14개 통과, 실패 0**. 충돌, UTF-16, 편집 중 저장, 실제 PTY roundtrip 등을 포함한다. UI 결함이 없다는 의미는 아니다.
- [최종 화면](../.qa/menu-audit/evidence/0286.png), [최종 상태](../.qa/menu-audit/evidence/0286-settled.json).
- 최종 검증 데이터는 responses/gpt-6-luna, 관리형 Pyright 연결 정상, 기본 Core 복원, pending=0.
- 제품 소스 수정 없음. 보고서와 `.qa/menu-audit` 검증 자료만 추가했다. 결함 수정은 수행하지 않았다.
- `data/daemon.json`에는 서비스 인증 정보가 있으므로 검증 폴더의 `.gitignore`로 `data/`를 제외했다. 이 디렉토리를 보고서와 함께 공유하지 않는다.
