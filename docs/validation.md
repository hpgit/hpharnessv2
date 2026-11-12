# 구현 및 검증 현황

이 문서는 계획과 실제 검증 결과를 구분한다. 2026-11-13 개발 환경에서 Windows를 주 실행 환경으로, SSH config의 `wsl`을 원격 Linux 대상으로 사용했다. 사내 시스템·SDK·DRM 문서·실기기에는 접근하지 않았다.

전체 진행 요약과 다음 작업의 우선순위·완료 기준은 [진행 현황](progress.md)에 정리한다. `6099e19`의 [Windows/Linux CI](https://github.com/hpgit/hpharnessv2/actions/runs/43322165266)는 모두 성공했으며 npm build/test, Rust workspace tests, Python worker tests를 포함한다.

## 실제 실행한 검증

| 구성 | 검증 내용 |
| --- | --- |
| 모델 API | localhost:10100의 gpt-6-luna로 Responses, Chat Completions, Messages 각각 도구 호출·결과 전달·최종 응답 확인 |
| 실제 agent loop | 모델이 작업공간 파일을 읽는 도구를 호출하고 결과·대화·context가 durable 기록에 남는 시나리오 |
| Core | Cordis nextStep 판단 함수 교체, 진행 요청 세대 고정, 안전 지점 이전, 후보 실패, 대기 시간 초과, 승인·검증·평가·롤백 |
| 실행 관리 | 순차 세션 입력, 병렬 슬롯, 승인 대기, 큐 취소, 개별 도구 승인, 설정 검증·마지막 정상값, 원문 대화 보존 |
| daemon | 클라이언트 종료 후 상태 유지·재접속, 인증 없는 RPC 거부 |
| 네이티브 GUI | Windows 창 생성, 한국어·Light/Dark/Solarized Light, 1380×900 및 900×650 대화·편집 배치, 빈 프로젝트 화면, 프로젝트·세션 생성, 파일 읽기·편집·저장, 실제 모델 응답 표시 |
| 편집 | 사용자 미저장 내용 보존, 저장 중 추가 편집, 외부 변경 충돌, UTF-16 위치·한글·surrogate pair 처리 |
| LSP | 실제 Pyright 초기화·자동완성·정의 탐색·진단; 타 서버는 공통 protocol과 등록 카탈로그 |
| 터미널 | Windows native PTY 생성·실제 shell 입출력·ANSI 처리. 일반 터미널 영구 복원 제외 |
| Git | 변경 diff, 선택 파일 patch만 staging, 잘못된 patch 거부 |
| SSH | 기존 wsl 별칭 연결, 한글 경로·기준 디렉토리·파일 hash 충돌, 연결 종료 후 장기 작업 재조회 |
| Python Linux | 원격의 별도 디렉토리에서 stdlib worker suite 실행 |
| 저장 | 한국어 검색, 원문 보관·출처 연결, 자산 버전 연결, vector identity·프로젝트 격리, quota 정지와 원문 보존 |
| 브라우저 정책 | origin·경로·동작 범위, 사용자 탭 유지, lease 만료·회수, Native Messaging frame 제한 |

테스트는 임시 데이터 디렉토리와 원격 홈 아래 별도 테스트 디렉토리를 사용한다. 원격 fixture는 재현·점검을 위해 일부 남겨 둔다. 실제 GUI 시나리오와 스크린샷은 로컬 `test-results`에 있으며 Git에 포함하지 않는다.

## 환경이 없어 완료로 판정하지 않은 항목

- 원격 Docker 실행: 현재 wsl에 Docker가 없다. CLI 인자·등록 계약은 구현했으나 실제 컨테이너 생성/USB/GPU 통합은 검증하지 않았다.
- QAIRT, enntools, NeuroPilot: 프로그램 등록·승인·original ONNX 기준·실패 처리를 구현했지만 사내 SDK 변환과 기기 평가 결과는 없다.
- Outlook·Office·UIA: optional worker 코드와 계약 테스트가 있다. 실제 회사 계정, DRM, 사내 메신저에서의 동작은 미검증이다.
- EmbeddingGemma 2: 지정 모델 경로, modality·prompt·768차원·index fingerprint, 로컬 실행·fallback 계약을 구현했다. 실제 모델 가중치·선택 의존성이 없어 추론 성능과 품질은 검증하지 않았다.
- Chrome: 확장프로그램·Rust bridge·정책 로직이 있다. 사용자의 실제 Chrome 프로필에 자동 설치하지 않았다. 사내 SSO/MFA·iframe·DRM 페이지 검증은 필요하다.
- Linux Rust GUI: Linux CI에서 Rust 컴파일과 workspace tests는 통과했다. 실제 Linux GUI 창 실행·한국어 IME·배율 검증은 남아 있다. CI 성공을 수동 화면 검증 완료로 간주하지 않는다.
- 사내 CA·proxy·mirror: 설정 경로는 구현했고 TLS 검증은 유지한다. 실제 사내 네트워크에서 연결 검증이 필요하다.

## 전체 요구사항 대비 남은 제품 작업

현재 빌드를 최초 합의한 모든 기능의 완성판으로 취급하지 않는다. 특히 다음 항목은 단순히 사내 접근 문제만은 아니며 제품 구현·통합·검증이 더 필요하다.

- Python 이외의 실제 대표 프로젝트에서 언어별 자동완성·정의·참조·진단 전체 수용 테스트. Android 혼용·다중 모듈 Gradle 프로젝트 검증과 언어 서버 배포 UX.
- Outlook 3개월 초기 수집·첨부 정책·메일 스레드 연결, Confluence 주기 수집, 업무 맥락에서 개발·문서로 이어지는 완성된 UI 흐름.
- PowerPoint 레이아웃별 내용 배치의 품질 평가, Word/Excel 복잡한 편집과 DRM 미리보기.
- 브라우저 사이트 연결 관리, 수집 진행·인증 대기 UX, 메일 웹 초안과 Confluence 게시 확인 화면. 현재 고급 RPC로 조합하는 부분이 있다.
- 사용자 평가를 바탕으로 개선안을 추천하는 품질·실패 복구 정책. 명시적 개선 절차는 구현했지만 자율적 자기 개선 품질을 입증한 것은 아니다.
- 자동 업데이트, 서명된 설치 패키지, 전체/프로젝트 가져오기 UI, 대용량 원본 관리·장기 운영·5개 프로젝트/10개 agent 부하 측정.

## 재현

Windows: `scripts/test.ps1 -LiveModels -Ssh -Lsp`. 모델 서버와 Pyright 설치가 필요하다. 기본 `scripts/test.ps1`은 외부 실환경 테스트를 skip한다.

원격 Python: `uv run --python .venv/Scripts/python.exe python packages/worker/test_remote_suite.py wsl`.

원격 Node: `uv run --python .venv/Scripts/python.exe python packages/worker/test_node_remote_suite.py wsl`.

네이티브 GUI: `HPH_DATA_DIR`을 별도의 테스트 디렉토리로 지정한 뒤 `hpharness-desktop --smoke-report REPORT.json --smoke-scenario PROJECT_DIRECTORY`. 해당 디렉토리에 `smoke.py`를 준비한다. 이 옵션은 실제 프로젝트 생성·파일 변경·로컬 모델 요청을 수행하므로 일반 작업 디렉토리 대신 테스트 폴더를 사용한다.

API 계약 근거: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Anthropic tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/), [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).
