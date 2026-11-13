# Antigravity Account Ledger

Token Monitor에서 Google 계정 및 사용자 지정 날짜 범위별로 Antigravity(Gemini 및 Claude/GPT 모델) 토큰 사용량과 USD 비용 내역을 추적하고, 여러 계정에 자동으로 귀속합니다.

## 호환성 및 설치

Token Monitor **0.81.0 이상**이 필요합니다. Token Monitor 0.80.0에는 플러그인 런타임이 포함되어 있지 않아 플러그인 설치가 거부됩니다. 0.81.0 이상에서는 내장된 **Token Monitor Community** 디렉터리에서 직접 설치하거나 **설정 → 플러그인 → 파일에서 설치**를 통해 플러그인 폴더 또는 `.tmplugin` 패키지를 가져온 뒤 활성화하세요.

플랫폼 테스트: Windows + Token Monitor 0.81.0에서 실기 검증했습니다. macOS와 Linux는 Node 계약과 단위 테스트로 검증했으며, 데스크톱 GUI는 실기 검증이 남아 있습니다.

## 기능

- **자동 다중 계정 귀속**: 로컬 Antigravity 상태에서 현재 Google 계정을 감지하고, 활성 계정 하트비트 타임라인과 로컬 할당량 재설정 기간, CLI/도구 로그 앵커를 사용해 사용량을 귀속합니다. 일치하지 않는 기록은 미귀속으로 별도 집계됩니다.
- **전체 모델 지원**: Gemini 모델과 Claude Sonnet/Opus, GPT 등 비 Gemini 모델을 추적하며 Gemini, Claude/GPT, Gemini 4 Argon 할당량 풀을 구분합니다.
- **사용자 지정 날짜 범위 및 계정 필터**: 임의의 `YYYY-MM-DD ~ YYYY-MM-DD` 기간과 개별 Google 계정으로 입력, 출력, 캐시 읽기, 추론 토큰 및 예상 USD 비용을 확인할 수 있습니다.
- **독립적인 홈 임베드 뷰**: 호스트 홈 레이아웃을 수정하지 않고 모듈 내부에 자체 헤더와 접기/펼치기 컨트롤을 렌더링하며, 필요할 때 계정별 사용량 비교 표를 펼칠 수 있습니다.

## 데이터 및 개인정보

플러그인은 다음 로컬 소스만 읽기 전용으로 접근합니다: `~/.gemini/` 아래의 Antigravity 대화 SQLite 데이터베이스, Antigravity `state.vscdb`, `~/.antigravity_tools`, 그리고 로컬 OAuth 자격 증명 파일 `jetski-standalone-oauth-token`, `antigravity-oauth-token`, `oauth_creds.json`(자격 증명 파일은 계정 이메일을 로컬에서 추출하는 데에만 사용됩니다). 모든 데이터는 로컬에서 읽고 저장되며, 자격 증명, 토큰 또는 사용량 기록은 어떤 외부 네트워크로도 전송되지 않습니다.

## 라이선스

[MIT](LICENSE) · [변경 로그](CHANGELOG.ko.md) · [모든 플러그인](../../README.ko.md)
