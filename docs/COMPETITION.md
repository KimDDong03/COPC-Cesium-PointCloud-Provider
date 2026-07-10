# 2026 공개SW 개발자대회 과제 대응

이 문서는 가이아쓰리디 지정과제
[COPC 데이터의 CesiumJS 가시화 기술 개발](https://www.kossa.kr/materials/2026/ossp/tasks-gaia3d.html)에
대한 `copc-cesium`의 구현·검증 근거를 한곳에 정리한다.

## 한 줄 결과

COPC URL 또는 브라우저의 로컬 파일을 3D Tiles로 사전 변환하지 않고
CesiumJS 장면에 직접 연결한다. COPC 옥트리 계층과 HTTP Range 요청을
이용해 현재 카메라에 필요한 점군을 단계적으로 선택·디코딩·렌더링하는
재사용 가능한 TypeScript 라이브러리다.

## 과제 적합성

| 과제 요구 방향 | 구현 근거 | 반복 검증 |
| --- | --- | --- |
| COPC 원본을 사전 타일링 없이 CesiumJS에 가시화 | `CopcSource`, `CopcPointCloudLayer`, URL·`File`/`Blob` 입력 | `npm run smoke:example:file` |
| COPC 내부 옥트리와 LoD 활용 | 카메라 프러스텀 기반 계층 확장, 화면 오차·점 간격 기반 선택, coverage/detail 단계 렌더 | `npm run benchmark:smoothness:contest` |
| 필요한 영역·해상도 청크만 요청 | 엄격한 HTTP `206 Partial Content` Range getter, Blob slice, 요청 병합 및 제한형 캐시 | 단위 테스트와 URL 스모크 |
| 빠르고 부드러운 웹 가시화 | Worker 디코딩·geometry 준비, 최신 카메라 우선순위, 취소·backpressure·prefetch, 점 예산 | contest/cold/warm smoothness QC |
| CesiumJS용 라이브러리 또는 플러그인 | `copc-cesium`, `/core`, `/cesium` 공개 엔트리와 타입 선언 | `npm run smoke:package` |
| 다른 CesiumJS 앱에서 재사용 | 저수준 `CopcPointCloudLayer`와 고수준 `CopcPointCloudCameraStream` 분리 | 소비자 타입 검사·번들 빌드 |
| 공개SW 품질 | MIT, 변경 이력, 기여 가이드, CI, 릴리스 후보 산출물, 명시적 제한사항 | `npm run qc` |

## 핵심 구조

```text
COPC URL / File / Blob
  -> exact byte-range getter
  -> metadata + hierarchy pages
  -> camera/frustum/LOD node selection
  -> bounded worker decode + coordinate transform
  -> Cesium-native point primitives
  -> progressive coverage/detail camera stream
```

`src/core`는 Cesium에 의존하지 않는 COPC 읽기·계층·캐시 계층이고,
`src/cesium`은 좌표 변환·렌더러·카메라 스트림 계층이다. 예제 뷰어의
정책과 UI는 `examples/basic-viewer`에 둔다. 자세한 구조는
[ARCHITECTURE.md](ARCHITECTURE.md), 공개 API는 [API.md](API.md)에 있다.

## 5분 재현

```bash
npm ci
npm run dev
```

`http://localhost:3000`에서 Autzen과 SoFi Stadium을 선택하고 카메라를
이동한다. coverage가 먼저 나타나고 detail이 이어지는지, 상태 패널에
LoD·캐시·prefetch 진단이 표시되는지 확인한다. 로컬 COPC 파일도 네트워크
URL과 동일한 레이어 API로 표시할 수 있다.

전체 자동 검증은 다음 한 명령으로 실행한다.

```bash
npm run qc
```

이 명령은 단위 테스트, 라이브러리·예제 빌드, 세 렌더러 비교, Autzen·SoFi
카메라 스트림 성능 게이트, cold/warm 회귀, 패키지 소비자 설치, URL·로컬
파일 브라우저 스모크, 공백 오류 검사를 순차 실행한다.

## 심사 근거 산출물

검증 산출물은 Git에서 제외된 `output/` 아래에 생성된다.

| 산출물 | 의미 |
| --- | --- |
| `output/renderer-benchmark/renderers.json` | 세 Cesium 렌더러의 반복 측정과 실제 WebGL GPU |
| `output/smoothness-benchmark/*.json` | 프리셋별로 보존된 FPS, 프레임 간격, 최초 응답, LoD, coverage/detail, 캐시·queue 지표 |
| `output/playwright/smoke-example-autzen-stream.png` | Autzen 색상 점군 스트리밍 가시화 증거 |
| `output/playwright/smoke-example-sofi-stream.png` | SoFi 카메라 스트림 가시화 증거 |
| `output/playwright/smoke-example-final-verification.png` | Custom URL 또는 로컬 파일 최종 스모크 상태 |
| `output/package-smoke/*.tgz` | 소비자 타입 검사와 빌드를 통과한 npm 패키지 후보 |

브라우저 결과에는 `browserGraphics.vendor`, `renderer`, `version`이
기록된다. Chromium에는 고성능 GPU 사용을 요청하지만 장치 번호(`GPU 0`,
`GPU 1`)를 추측하지 않고 실제 WebGL 렌더러를 성능 결과의 기준으로 쓴다.
같은 기준선 비교는 기본적으로 동일 GPU 문자열만 허용한다.

## 정직한 제한사항

- 현재 버전은 `0.1.0`이며 1.0 API 안정성을 선언하지 않는다.
- COPC WKT가 외부 datum grid를 요구하면 명시적 변환을 제공해야 한다.
- 브라우저 프레임 간격과 CPU 제출 시간을 계측하지만 전용 GPU profiler는 아니다.
- 편집, 영구 오프라인 캐시, 비-COPC 형식, 도메인별 스타일은 범위 밖이다.
- 더 많은 COPC 제작 도구·CRS·브라우저·저사양 장치 표본이 필요하다.

완전한 타입 검사 예시는
[`examples/minimal-layer.ts`](../examples/minimal-layer.ts)에 있다. 상세한
성능 측정법과 임계값은 [PERFORMANCE.md](PERFORMANCE.md)에 있다.
