# 진행 현황과 다음 작업

기준일: 2026-11-13. 구현 기준 커밋: `6099e19`.

현재는 **Windows에서 실행되는 Cordis harness와 Rust 네이티브 개발 GUI의 개발 빌드**다. 모델 호출, 도구 실행, core 교체, 파일 편집, SSH 등 주요 실행 경로를 검증했다. 최초 합의한 모든 업무 연동과 언어 지원을 충족한 첫 사용 가능 버전으로 완료 판정한 상태는 아니다.

이 문서는 다음 개발을 이어가기 위한 현황과 작업 순서를 정리한다. 요구사항 자체는 [requirements.md](requirements.md), 장기 설계는 [architecture.md](architecture.md), 상세 수용 기준은 [implementation-plan.md](implementation-plan.md), 검증 근거와 재현 방법은 [validation.md](validation.md)를 따른다. 계획 문서에 적힌 기능을 구현 완료로 간주하지 않는다.

## 1. 유지해야 할 방향과 제약

- Windows 우선, Linux 호환 유지. 사용자 PC에서 WSL 없이 실행한다. 현재 SSH 테스트의 `wsl`은 원격 Linux 대상으로 사용했을 뿐 제품의 필수 의존성이 아니다.
- 화면 렌더링과 UI 로직은 Rust 네이티브다. 초기 GPUI 후보 대신 현재는 eframe/egui를 사용한다.
- Cordis 플러그인 구조로 agent 판단 로직을 교체한다. 진행 중 LLM 요청·도구 실행을 끝낸 안전 지점에서 전환하며 원본 대화·도구 기록을 보존한다.
- 최종 방향은 자율적 자기 개선이지만 현재 개선은 명시적 요청과 제안 동의를 출발점으로 한다. 평가가 없으면 성공으로 추정하지 않고 미정으로 남긴다.
- 원본 메일·wiki·Confluence·Office 자료와 원본 대화·실행 기록을 개선 과정에서 임의로 바꾸지 않는다. 기억은 harness에서 관리하고 Obsidian은 일반 노트로 사용한다.
- 단일 사용자부터 시작한다. 기준 PC는 64GB RAM, i9-14900K, RTX3050 OEM이며 프로젝트 약 5개·agent 최대 10개를 목표로 한다. 이 규모의 실제 부하 검증은 아직 남아 있다.
- 수집 원본 영역은 50GB 한도, 초기 메일 탐색은 최근 3개월이다. 이전 자료는 요청 시 추가 탐색한다. quota 도달을 원본 자동 삭제로 해결하지 않는다.
- Node.js·Python은 앱에 포함하지 않는다. Python은 uv와 작업공간 내부 인터프리터·캐시를 사용한다. 언어 서버는 앱이 관리하는 별도 패키지 방향이다.
- 사내 CA·인증 없는 proxy·mirror·registry와 기존 SSH config를 재사용한다. 자격증명은 복잡한 별도 API보다 설정 파일의 경로 지정 방식을 사용한다.
- GPU pool은 현재 접근할 수 없으므로 명시적인 dummy로 유지한다. 사내 SDK·DRM·SSO·메일·메신저는 사내 환경 확인 없이 완료 판정하지 않는다.

## 2. 지금까지 진행한 일

### 변경 이력

| 커밋 | 내용 |
| --- | --- |
| `3708577` | 저장소 초기화 |
| `eaddd2c` | 요구사항·설계 문서, Cordis 실행 기반, 모델 어댑터, worker, Rust 개발 GUI와 테스트 구현 |
| `6099e19` | Codex Desktop을 참고한 GUI 재구성, 테마·대화 렌더링·탐색 개선과 회귀 수정 |

위 구현 커밋은 `origin/main`에 푸시되어 있다.

### 실행 기반

| 영역 | 구현 및 확인한 범위 | 남은 경계 |
| --- | --- | --- |
| Core 교체 | Cordis 3.18.1의 `agentCore.nextStep` 교체, 실행 세대 고정, 안전 지점 이전, 후보 초기화 실패·전환 대기 초과·이전 세대 정리 | 임의의 JS 실행 스택이나 모든 감독 프로세스 코드를 hot reload하는 것은 아님. 전이 의존성은 독립 bundle 또는 버전 고정 필요 |
| 모델 | Responses, OpenAI compatible Chat Completions, Anthropic Messages의 호출·도구 결과 변환·취소·네트워크 설정 | 실제 사내 endpoint와 인증·CA 조합 검증 필요 |
| 실행 관리 | 세션별 큐, agent/model 동시성 분리, 하위 agent와 부모 대기, 승인, 취소, 선택적 횟수·시간·토큰 한도와 사용량 | 장기 부하·장애 조합·사용자 관점 상태 표시 고도화 필요 |
| 기록·복구 | SQLite 기록, 원문 보존, GUI와 daemon 분리, GUI 재접속, supervisor 재시작 시 불확실한 작업을 interrupted로 표시 | 외부 효과를 무조건 재실행하거나 exactly-once로 보장하지 않음 |
| Context·기억 | 출처가 있는 프로젝트/공통 기억, 원문을 남기는 context 압축 기록, 한국어 키워드 검색 fallback | 현재 압축은 발췌형이며 의미 요약 품질·검색 활용 효과 검증 필요 |
| 자기 개선 | 제안→동의→후보 계약 검증→적용→사용자 평가→core 롤백 RPC, 후보 hash 확인 | 자유 서술 검증 계획의 자동 실행이나 자율 개선 품질은 미구현·미입증. 롤백으로 외부 작업 효과가 취소되지는 않음 |

### 개발 GUI와 실행 대상

- Rust eframe/egui 창에서 프로젝트·세션, 대화, 승인, 기억, 설정, 실행 패널을 제공한다.
- Codex 스타일의 회색 사이드바·흰 본문·제한된 대화 폭·둥근 입력창·선 아이콘을 적용했다. Light가 기본이며 Dark와 Solarized Light를 선택할 수 있다.
- assistant 답변은 Markdown, 도구 결과는 접힌 상세 항목으로 표시한다. 프로젝트/작업 검색, 사이드바 접기, 대화/편집 전환을 제공한다.
- 파일 탐색, 탭, 저장 원본과의 분할, 구문 강조, LSP 연결·자동완성·정의·참조·진단 경로, PTY, Git diff·선택 파일 patch staging, 이미지 미리보기가 있다.
- 저장 시 hash를 확인하며 외부 수정과 미저장 편집을 보호한다. 최근 UI 작업에서 세션별 버퍼 표시·저장 범위, 프로젝트 접기, `waiting_child` 상태, 좁은 화면의 상태 표시를 수정했다.
- 세션별 로컬/SSH/컨테이너 실행 대상을 전달한다. 기존 SSH config와 jump host 설정을 사용하는 경로, Python worker 배포, 파일 작업, 장기 작업 조회·취소를 구현했다.
- Docker 생성·시작·exec, ADB, SDK 프로그램 등록은 worker 경로가 있다. 실제 Docker와 기기 검증은 별도다.
- GUI의 `+`는 파일 탐색을 연다. 일반 첨부 업로드가 아니다. 고급 RPC 패널은 전용 제품 화면을 대신하는 현재 접근 경로이며, 완성된 Office·브라우저 UX를 뜻하지 않는다.

### 업무 연동 기반

| 영역 | 현재 상태 |
| --- | --- |
| 지식·자산 | 원문 보관·출처·검색·프로젝트 간 공유 자산/버전·vector identity·quota 경로와 테스트 구현 |
| 임베딩 | 로컬 EmbeddingGemma 2 경로, 텍스트·코드·이미지, 768차원, query/document 구분, 색인 fingerprint·중지/재개 계약 구현. 실제 가중치 추론은 미검증 |
| Chrome | 직접 설치할 확장프로그램, Rust Native Messaging bridge, 사이트 범위·탭 인계·lease 정책 구현. 회사 Chrome SSO/MFA·정기 수집 미검증 |
| Outlook | Classic Outlook COM fetch·첨부 추출 경로. 기본 원문은 속성 JSON이며 완전한 `.msg` 사본과 다름. 선택적 `.msg` 보관은 첨부까지 용량을 사용 |
| Office | COM 기반 파일 hash·사전 보관본·수정 경로, PowerPoint template slide 복사와 이름 있는 text/image shape 교체 |
| 메신저·computer use | Windows UI Automation worker와 시간 제한 인계·회수 경로. 실제 사내 메신저 연동 미검증 |
| NPU | QAIRT·enntools·NeuroPilot용 프로그램 등록/실행 계약, 원본 ONNX 기준 식별과 결과 보존. 실제 SDK 변환·기기 평가는 미검증 |
| GPU pool | 제출·진행·실패·취소·업로드·다운로드 dummy. 결과에 simulated/dummy를 명시 |

## 3. 검증 결과

- `localhost:10100/v1`의 `gpt-6-luna`로 세 모델 protocol의 도구 round trip을 확인했다. 실제 agent loop의 파일 읽기와 기록도 검증했다.
- Windows GUI에서 실제 프로젝트·세션 생성, 파일 읽기/수정/저장, 모델 응답 표시를 확인했다. 최신 UI 검증은 1380×900, 900×650, 실행 패널을 연 850×600, 빈 화면 및 세 테마를 포함한다.
- 최신 UI 변경의 로컬 Rust 테스트는 13개 통과했고 `cargo clippy -p hpharness-desktop --all-targets -- -D warnings`와 빌드도 통과했다.
- Pyright 실제 연결, Windows ConPTY, Git patch, SSH `wsl` 파일 작업·연결 단절 후 장기 작업 재조회 및 원격 worker 테스트를 실행했다. 나머지 언어 서버의 대표 프로젝트 검증을 대신하지 않는다.
- **`6099e19`의 Windows/Linux CI 모두 성공**: [GitHub Actions 실행 기록](https://github.com/hpgit/hpharnessv2/actions/runs/43322165266). 두 OS에서 npm build/test, Rust workspace tests, Python worker tests를 통과했다. CI 성공은 Linux GUI 창·IME나 사내 통합 검증을 뜻하지 않는다.
- 실제 GUI report/PNG는 로컬 `test-results/codex-ui/`에 있다. `edit-final.json`과 `edit-small.json`은 `scenarioPhase: 5`, `assistantMessages: 1`, `savedFiles: 1`을 기록한다. 이 파일들은 Git 제외 대상이다.

## 4. 진행해야 할 일

아래 순서는 다음 개발을 위한 권장 순서이며 합의된 첫 사용 가능 버전의 범위를 축소하지 않는다. 모든 지정 언어 지원 등 원래 요구한 완료 조건은 그대로 유지한다.

### P0 — 실제 개발에 쓰면서 발견할 문제와 회귀 기준

| 작업 | 완료 기준 |
| --- | --- |
| Windows 편집 UX 검증 | 한글 IME 조합·선택·붙여넣기·undo, 배율 변경, 키보드 탐색, 긴 대화/코드/표, 큰 파일, 패널 전환을 실제 입력으로 확인하고 회귀 항목 기록 |
| 세션·대상 전환 검증 강화 | 2개 이상의 프로젝트에서 같은 이름의 파일, 미저장 버퍼, 검색으로 작업 이동, 저장 중 세션 변경을 조합해 오대상 쓰기·상태 혼동이 없음을 확인 |
| 지정 언어 전체 지원 | Python, C/C++, CMake, TypeScript, Rust, Kotlin, Java, Gradle Groovy 각각 대표 프로젝트로 자동완성·정의·참조·진단 수용 테스트 통과 |
| 언어 서버 패키지 UX | 별도 관리 패키지의 설치·버전·진단·제거, mirror/오프라인 설치, 로컬/SSH/컨테이너별 실행 경로를 사용자가 확인 가능 |
| Android 대표 환경 | Kotlin/Java 혼용·다중 모듈, 실제 Gradle/AGP/JDK 버전, NDK arm64-v8a·CMake·compile_commands를 연결해 편집부터 빌드까지 확인 |
| 원격 Docker | Docker가 있는 Linux에서 새 컨테이너 생성, registry 이미지, mount 대응, 경로·권한·LSP·장기 작업·재접속 검증. 기존 컨테이너/파일 보존 확인 |
| Linux GUI | 실제 창 실행과 한국어 입력·폰트·배율·PTY를 확인. 현재 CI 빌드/테스트와 구분해 기록 |

### P1 — 기억·업무 맥락·산출물의 연결

| 작업 | 완료 기준 |
| --- | --- |
| 실제 임베딩 실행 | 모델 revision·로컬 가중치·의존성을 고정하고 텍스트/코드/이미지 768차원 검색, 한국어 품질, 메모리·지연, 중단/재개·fallback 검증 |
| 기억 활용 평가 | 여러 프로젝트가 동일 모델의 서로 다른 버전을 참조하는 사례에서 출처와 버전을 유지하고, 기억 사용 전후 agent 판단을 사용자가 평가 가능 |
| Chrome 제품 흐름 | 연결 설정→사이트 범위→탭 인계→조회→인증 대기/회수/재개를 전용 UI로 제공. 사내 확장 설치·SSO/MFA·iframe·API 없는 Confluence 접근 확인 |
| Outlook 수집 | 최근 3개월·보낸 메일·스레드·첨부 선택·중복/증분 수집·50GB quota를 연결. JSON과 `.msg` 보관 차이를 UI에 명시하고 실제 profile로 검증 |
| 메신저 | 사내 제품의 UIA 요소로 대화 접근 가능 여부 확인, 사용자 제어 회수·시간 단위 허용·읽기 범위 검증. 초안은 harness에 표시 |
| 결과 작성 | 메일은 웹 초안, Confluence는 확인 후 게시, Obsidian은 지정 폴더 새 노트, GitHub Enterprise는 PR 생성까지 각각 다른 완료 지점을 UI와 실제 흐름에 반영 |
| Office/DRM | 기존 Word/Excel/PowerPoint의 수정·저장·보관본 복구를 실제 DRM 환경에서 확인. 회사 PPT 레이아웃별 text/image 치환과 내용 밀도를 사용자 평가 |
| 문서 미리보기 | 현재 미지원 안내인 Office/PDF 미리보기의 기술 경로와 DRM 제약을 검증한 후 구현 |
| 전송 범위 | 원문·첨부·기억·하위 agent에 대한 모델 전송 범위 설정을 end-to-end로 확인하고 endpoint별 제외/가림 처리를 제품 흐름에 연결 |

### P2 — 학습·모바일 배포와 자기 개선

| 작업 | 완료 기준 |
| --- | --- |
| NPU 실제 등록 | 사내 Docker 이미지·스크립트·평가 프로그램을 agent가 제안→동의→시험→등록하는 전체 흐름 확인 |
| NPU 평가 | PyTorch QAT→원본 ONNX→SDK별 파생본→세 SDK 변환→Linux USB 기기 평가. 최종 출력 비교 기준은 PyTorch가 아닌 원본 ONNX이며 SDK별 레이어 변경과 출처 보존 |
| GPU 실제 CLI | 사내 접근 후 dummy와 동일 계약으로 CLI 어댑터 구현, workload ID·전송·모니터링·취소·응답 유실 후 재조회 확인. 현재 dummy를 실제 성공으로 표시하지 않음 |
| 자기 개선 전용 UI | 명시적 개선 요청 1건에 대해 변경 범위·diff·시험 근거·적용 상태·사용자 평가·복원을 한 흐름으로 제공 |
| 판단·복구 품질 | 사용자/프로젝트 기억 활용, agent 판단, 실패 원인 분석·복구를 우선 평가. 미평가를 성공으로 처리하지 않고 개선 전후 근거 기록 |
| 교체 가능 범위 확대 | 현재 `nextStep` 중심 경계를 바탕으로 정책·context·도구 구현의 교체 계약과 상태 호환성 검증 확장. 감독 프로세스/저장 형식 변경은 별도 절차로 구분 |

### P3 — 운영과 배포

- 프로젝트 5개·agent 10개에서 LSP·색인·빌드·모델 요청 경합, UI 응답·메모리·저장 증가·장기 작업을 측정하고 운영 기본값을 조정한다.
- daemon/SSH/컨테이너 장애, 작업 결과 응답 유실, 승인 이후 인자 변경, 같은 파일/기기 동시 사용을 조합한 복구 검증을 보강한다.
- 50GB quota 근접/초과와 SQLite·파일 저장의 부분 실패에서 원본 보존·수집 보류·재개·색인 재생성을 검증한다.
- 수동 내보내기뿐 아니라 가져오기 UI·형식 호환·원문 포함 선택·자격증명 경로 재연결을 구현·검증한다. 당시 코드 상태 복원은 요구 범위가 아니다.
- Node/Python 미포함 설치 진단, 사내 CA/proxy/mirror, 설치 패키지, 수동 업데이트·이전 버전 복원 절차를 정리한다. 자동 업데이트는 후속 선택 사항이다.
- 현재 한국어 UI의 영어 전환, 접근성, 각 업무 전용 설정/진행 화면을 보완한다. 사용자 20명 규모 확장은 1인 운영 경험 이후 재평가한다.

## 5. 사내에서 추가 확보할 정보

현재 작업을 막는 일괄 승인 요청이 아니라 실제 통합 검증에 필요한 입력 목록이다.

- Classic Outlook profile, 회사 웹메일·Confluence·메신저 접근 환경, Chrome 확장 설치 정책, 대표 SSO/MFA 흐름.
- DRM 적용 Word/Excel/PPT 예제와 슬라이드 유형별 template, 실제 편집 가능한 shape 이름/구조.
- Docker registry/image, SDK 버전, 기존 변환·평가 프로그램의 입출력과 성공/실패 판정 규칙.
- 대표 원본 ONNX·입력 데이터·허용 오차·비교할 출력, Linux USB 기기와 ADB 권한.
- GPU pool CLI 사용법·인증·workload/전송/모니터링 예제.
- GitHub Enterprise 주소, proxy/CA/mirror 실제 경로, Android Gradle/AGP/JDK/NDK 조합.
- EmbeddingGemma 2의 실제 로컬 가중치 위치·revision과 장치별 실행 설정.

## 6. 다음 작업 재개 방법

1. 이 문서와 각 패키지 README를 읽고 `git status` 및 최신 CI를 확인한다. 아키텍처/계획 초안의 후보와 현재 구현을 구분한다.
2. `scripts/bootstrap.ps1`, `scripts/run.ps1`로 개발 빌드를 실행한다. 시작 요구사항은 루트 README를 따른다.
3. 기본 검증은 `scripts/test.ps1`. 모델·SSH·Pyright가 준비되면 `scripts/test.ps1 -LiveModels -Ssh -Lsp`를 사용한다. Python은 작업공간 `.tools/python`, `.venv`, `.cache/uv` 경로를 유지한다.
4. GUI 시험은 별도의 `HPH_DATA_DIR`와 `smoke.py`가 있는 임시 프로젝트에서 진행한다. `--smoke-report`, `--smoke-scenario`, `--smoke-chat`, `--smoke-size`, `--smoke-panel`, 테마 옵션은 [Desktop README](../crates/desktop/README.md)에 설명되어 있다.
5. 한 번에 검증 가능한 작업을 선택하고 구현 범위·실행 근거·남은 제약을 이 문서와 `validation.md`에 갱신한다. fixture 통과를 사내 실환경 완료로 바꾸지 않는다.

소스 진입점: [Desktop](../crates/desktop/src/main.rs), [UI](../crates/desktop/src/interface.rs), [테마·아이콘](../crates/desktop/src/appearance.rs), [Harness 계약](../packages/harness/README.md), [Worker 계약](../packages/worker/README.md).
