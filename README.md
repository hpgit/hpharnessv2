# HPHarness

Windows 우선의 **Rust 네이티브 개발 화면 + Cordis AI agent runtime**입니다. UI와 실행 프로세스를 분리하며, 모델 요청·도구의 결과를 기록한 안전 지점에서 core 판단 함수를 교체합니다. Windows 실행에 WSL은 필요하지 않습니다. SSH 설정의 Linux 호스트와 Docker를 별도 실행 대상으로 사용합니다.

현재는 동작하는 개발 빌드입니다. [전체 요구사항](docs/requirements.md)을 모두 검증한 정식 릴리스라는 의미는 아닙니다. 실제 사내 서비스·DRM·NPU SDK와 언어별 IDE 완성도는 [검증 현황](docs/validation.md)을 확인하세요. GPU pool은 명시적인 dummy입니다.

## 시작하기

필요한 도구: Node.js 24 이상(검증은 26), Rust/Cargo와 Windows MSVC 빌드 도구, uv. SSH 사용 시 OpenSSH. Node/Python은 앱에 내장하지 않습니다.

```powershell
./scripts/bootstrap.ps1
./scripts/run.ps1
```

Bootstrap은 npm lockfile과 작업공간 `.tools/python`, `.venv`, `.cache/uv`를 사용합니다. 사내 mirror는 npm/Cargo/uv의 기존 설정을 사용합니다. 수동 빌드는 `npm ci`, `npm run build`, `cargo build --workspace`; 실행은 `cargo run -p hpharness-desktop`입니다.

GUI에서 프로젝트 이름과 절대 경로를 등록하고 세션을 만드세요. 모델 기본값은 `http://localhost:10100/v1`, `gpt-6-luna`, Responses입니다. 설정에서 Chat Completions 또는 Anthropic Messages를 선택할 수 있습니다. 다른 서비스에는 URL·모델·키를 담은 파일 경로를 지정합니다. [설정 예시](config/example.yaml).

데이터는 사용자 홈 `.hpharness`에 저장됩니다. `HPH_DATA_DIR`로 변경할 수 있습니다. UI 종료 후 daemon과 진행 작업은 유지되며 다시 열면 같은 기록에 연결합니다. daemon 장애 후 불확실한 실행을 자동 반복하지 않습니다. `HPH_ROOT`, `HPH_NODE`, `HPH_BACKEND`로 저장소·Node·백엔드 경로를 지정할 수 있습니다. 데이터 디렉토리와 토큰을 포함한 `daemon.json`은 Git에 넣지 마세요.

## 구성

| 경로 | 역할 |
| --- | --- |
| `crates/desktop` | Rust 창, Codex 스타일 대화·프로젝트 탐색, Light/Dark/Solarized, 편집·LSP·PTY·Git·승인·기억·설정 |
| `packages/harness` | Cordis 실행 세대, 판단 함수 교체, SQLite 기록, 작업 큐, 승인·자기 개선, daemon |
| `packages/providers` | 세 모델 API, 도구 결과 변환, 취소·proxy·CA |
| `packages/extensions` | LSP·MCP stdio, 브라우저 정책, 원문 보관·검색, 공유 자산, Git |
| `packages/worker` | Python, SSH·Docker·장기 작업·ADB·Office·Outlook·UIA·SDK 등록·GPU dummy·임베딩 |
| `browser-extension`, `crates/browser-bridge` | Chrome 확장프로그램과 Rust Native Messaging bridge |

렌더링과 UI 로직은 Rust이며 웹뷰를 사용하지 않습니다. GPUI 후보 대신 Windows 빌드·실행을 검증한 eframe을 채택했습니다.

화면은 Codex Desktop의 구성을 참고해 프로젝트·작업 사이드바, 가운데 대화와 입력창, 간결한 상단 바를 사용합니다. 중립적인 Light가 기본이며 설정에서 Dark 또는 Solarized Light를 선택할 수 있습니다. 답변은 Markdown으로 표시하고 도구 결과는 펼쳐서 확인합니다. 실행 패널은 처음에는 접혀 있으며 상단 터미널 버튼으로 엽니다. `대화 / 편집`으로 배치를 전환합니다. [화면 구성](docs/ui-design.md).

## 편집·원격 실행

파일 저장은 원래 내용의 hash를 확인하며 미저장 편집·외부 변경을 조용히 덮어쓰지 않습니다. 언어 서버는 작업 대상 toolchain에 맞춰 설치·등록합니다. `./scripts/install-language-tools.ps1`로 Python·TypeScript 서버를 별도 관리 패키지에 설치할 수 있습니다.

다른 언어는 clangd, cmake-language-server, rust-analyzer, kotlin-lsp, jdtls, Groovy 서버를 등록합니다. 카탈로그 등록은 프로젝트별 완전한 지원을 검증했다는 뜻이 아닙니다. Android Gradle/AGP/JDK/NDK 조합은 추가 검증해야 합니다. SSH LSP는 원격 서버와 원격 URI를 사용합니다.

SSH 프로젝트에는 기존 별칭과 POSIX 절대 경로를 지정합니다. 장기 작업은 worker `jobs.start/status/cancel`로 관리합니다. 일반 터미널 복원은 보장하지 않습니다. 기존 컨테이너를 자동 삭제하지 않습니다. 터미널·agent 명령은 승인 계정의 권한으로 실행되며 cwd는 OS sandbox가 아닙니다. Agent 쓰기·명령은 기본 개별 승인입니다. 고급 RPC 패널은 사용자의 직접 조작 도구입니다.

## Core 교체·자기 개선

[Core 계약과 RPC](packages/harness/README.md)를 참조하세요. ESM 후보는 Cordis `agentCore` 서비스를 등록하고 `nextStep(api)`가 실제 다음 행동을 결정합니다. 작업은 이전 세대에 남거나 명시적 요청에 따라 안전 지점에서 전환합니다. 이전 세대는 참조 작업이 끝난 후 정리합니다.

자기 개선은 제안·동의·후보 검증·적용·평가 순서입니다. 사용자 평가가 없으면 unknown입니다. 롤백은 이전 core를 활성화하며 외부 효과를 취소했다고 표시하지 않습니다. 플러그인은 신뢰한 로컬 코드이며 Cordis는 보안 sandbox가 아닙니다.

## Chrome 연결

1. `cargo build --release -p hpharness-browser-bridge`.
2. Chrome에서 `browser-extension`을 압축 해제된 확장프로그램으로 로드합니다.
3. 확장 ID로 `./scripts/register-browser.ps1 -ExtensionId ID` 실행. 사용자 HKCU에 Native Messaging host를 등록합니다.
4. Harness `browser.configure`로 origin·포함/제외 경로·동작을 등록하고 확장 팝업에서 탭을 인계합니다.

미연결 시 Chrome을 임의 실행하지 않습니다. 모델이 사이트 범위를 확대할 수 없습니다. 현재는 수동 연결·조회·조작 경로입니다. SSO/MFA·iframe·정기 수집은 실제 환경 검증이 필요합니다.

## Office·임베딩

[Worker 문서](packages/worker/README.md)에 선택 의존성과 RPC를 정리했습니다. Office는 설치된 앱·pywin32, 인계·원본 hash·사전 보관본을 사용합니다. UIA는 선택 패키지와 시간 제한 인계가 필요합니다.

EmbeddingGemma 2는 지정한 로컬 모델 디렉토리만 읽습니다. 파일을 자동 다운로드하거나 가짜 벡터를 만들지 않습니다. 모델이 없으면 키워드 검색을 유지합니다. 실제 가중치·의존성 환경의 추론 검증이 남아 있습니다.

## 테스트

```powershell
./scripts/test.ps1
./scripts/test.ps1 -LiveModels -Ssh -Lsp
```

두 번째 명령은 localhost 모델, SSH wsl, 설치한 Pyright를 사용합니다. SSH 테스트는 원격 홈의 별도 디렉토리를 사용합니다. 사내 연결 기능을 fixture 성공으로 완료 처리하지 않습니다.

[요구사항](docs/requirements.md) · [아키텍처](docs/architecture.md) · [구현 계획](docs/implementation-plan.md) · [검증 현황](docs/validation.md)
