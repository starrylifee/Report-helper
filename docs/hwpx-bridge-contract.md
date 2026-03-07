# HWPX Bridge Contract

`MinuteFlow Studio`는 HWP/HWPX를 브라우저에서 직접 파싱하지 않는다.
로컬 전용 브리지가 `hwpx-cli`를 중심으로 HWPX를 다루고, 웹앱은 그 브리지와 통신한다.

기본 주소:

- `http://127.0.0.1:48153`

## 1. Health Check

- `GET /api/health`
- 응답 예시:

```json
{
  "ok": true,
  "engine": "hwpx-cli",
  "capabilities": {
    "normalizeHwp": true,
    "previewPdf": true,
    "exportHwpx": false
  }
}
```

## 2. HWPX Open

- `POST /api/hwpx/open`
- `multipart/form-data`
- 필드:
  - `source`: 원본 `.hwp` 또는 `.hwpx`
  - `sourceType`: `hwp` 또는 `hwpx`
- 응답:

```json
{
  "normalizedName": "minutes.hwpx",
  "normalizedBytesBase64": "<base64>",
  "previewPdfBase64": "<base64>"
}
```

설명:

- `.hwp`가 들어오면 브리지가 먼저 `.hwpx`로 정규화한다.
- 웹앱은 `previewPdfBase64`를 작업 캔버스 렌더링용으로 사용한다.
- `normalizedBytesBase64`는 이후 HWPX 저장 시 원본 역할을 한다.

## 3. HWPX Export

- `POST /api/hwpx/export`
- `multipart/form-data`
- 필드:
  - `source`: 정규화된 `.hwpx`
  - `previewPdf`: 웹앱에서 편집 결과를 합성한 PDF
  - `annotations`: JSON 문자열
  - `sourceType`: 항상 `hwpx`
  - `originalType`: `hwp` 또는 `hwpx`
- 응답:
  - 수정된 `.hwpx` 바이너리

## annotations JSON 예시

```json
[
  {
    "id": "ann-1234",
    "type": "text",
    "pageNumber": 1,
    "x": 0.14,
    "y": 0.28,
    "width": 0.36,
    "height": 0.08,
    "text": "회의 결과를 반영한 문구",
    "fontSize": 18,
    "color": "#1f1b17",
    "aspectRatio": null,
    "src": null
  }
]
```

## 구현 메모

- 1차 구현:
  - `hwpx-cli`로 `.hwp -> .hwpx` 정규화
  - `hwpx-cli read` 결과를 기반으로 텍스트형 PDF 미리보기 생성
  - HWPX export는 capability가 준비되기 전까지 비활성화
- 확장 구현:
  - `@masteroflearning/hwpxcore` 기반으로 텍스트/이미지/서명 오브젝트를 직접 배치
  - PDF 미리보기와 HWPX 결과의 좌표 체계를 최대한 맞춤
