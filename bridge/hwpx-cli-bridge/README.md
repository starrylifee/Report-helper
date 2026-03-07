# hwpx-cli Bridge

`MinuteFlow Studio`가 로컬에서 HWP/HWPX를 열 수 있게 해주는 브리지 골격이다.

현재 범위:

- `hwpx-cli` 또는 동등한 CLI로 `.hwp -> .hwpx` 정규화
- `.hwpx` 본문 텍스트 추출
- 추출한 텍스트로 간단한 PDF 미리보기 생성
- 웹앱에 `health` / `open` API 제공

현재 제외:

- HWPX 구조를 직접 수정해서 다시 저장하는 export

## 설치

```bash
npm install
```

## 환경 변수

- `PORT`: 기본 `48153`
- `HWPXCLI_HWP_TO_HWPX_CMD`: `.hwp -> .hwpx` 변환 커맨드 템플릿
- `HWPXCLI_READ_CMD`: `.hwpx` 텍스트 추출 커맨드 템플릿

템플릿 토큰:

- `{input}`: 입력 파일 경로
- `{output}`: 출력 파일 경로

예시:

```bash
set HWPXCLI_HWP_TO_HWPX_CMD=hwpxcli hwp-to-hwpx "{input}" "{output}"
set HWPXCLI_READ_CMD=hwpxcli read "{input}"
```

실제 명령 형식은 사용하는 `hwpx-cli` 버전에 맞게 조정해야 한다.

## 실행

```bash
npm run start
```

브리지가 켜지면 웹앱에서 `http://127.0.0.1:48153/api/health`를 확인한다.
