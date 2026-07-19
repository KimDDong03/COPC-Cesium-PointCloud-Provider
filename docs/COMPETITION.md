# COPC Cesium PointCloud Provider — Gaia3D 2026 과제 근거

[가이아쓰리디 공식 지정과제](https://www.kossa.kr/materials/2026/ossp/tasks-gaia3d.html)의
COPC 데이터 CesiumJS 직접 가시화 요구와 **COPC Cesium PointCloud Provider**
프로젝트(`copc-cesium` 패키지)의 구현·검증 근거를 연결한 문서다.

공개 참조 뷰어: <https://kimddong03.github.io/COPC-Cesium-PointCloud-Provider/>

## 한 줄 결과

COPC URL, `File`, `Blob`을 3D Tiles로 사전 변환하지 않고 CesiumJS 장면에
직접 연결한다. COPC 옥트리와 HTTP Range를 이용해 현재 카메라에 필요한
점군을 선택·디코딩·렌더링하는 재사용 가능한 TypeScript 라이브러리다.

## 공모전 범위 경계

범위 안:

- COPC URL, `File`, `Blob`의 정확한 byte-range 읽기.
- COPC hierarchy, octree, LOD, 카메라 가시성 기반 노드 선택.
- 브라우저 worker, bounded cache, prefetch, priority, cancellation.
- 좌표 변환과 Cesium-native point rendering.
- 재사용 API, 참조 예제, 단위·패키지·브라우저·성능 검증.

범위 밖:

- AWS, CloudFront, S3 운영 구성이나 데이터 호스팅 제품.
- CDN, edge 서버, backend proxy.
- COPC-to-3D-Tiles 또는 다른 사전 변환 파이프라인.
- 외부 전달 인프라를 라이브러리 성능 우위의 근거로 삼는 주장.

공개 COPC URL은 테스트 입력이다. GitHub Pages는 정적 예제 접근을 위한
지원 수단이며 라이브러리의 런타임 의존성이나 성능 근거가 아니다.

## 요구사항 대응

| 과제 방향 | 구현 | 반복 검증 |
| --- | --- | --- |
| COPC 직접 가시화 | `CopcSource`, `CopcPointCloudLayer`, URL/`File`/`Blob` | `npm run smoke:example:file` |
| 옥트리와 LOD 활용 | 카메라/frustum 기반 hierarchy 확장과 bounded node selection | smoothness benchmark |
| 필요한 구간만 읽기 | 엄격한 HTTP `206` Range getter와 Blob slice | 단위 테스트, live Range QC |
| 부드러운 브라우저 렌더링 | worker decode/geometry, cache, priority, prefetch, safe swap | contest/cold/warm gates |
| CesiumJS 라이브러리 | `copc-cesium`, `/core`, `/cesium` ESM entry와 타입 선언 | package consumer smoke |
| 다른 앱에서 재사용 | 저수준 layer와 고수준 camera stream 분리 | consumer type check/build |
| 공개SW 품질 | MIT, CI, CodeQL, notices, SPDX SBOM, provenance | product/full QC |

## 구조

```text
COPC URL / File / Blob
  -> exact byte-range getter
  -> metadata + hierarchy
  -> camera/frustum/LOD selection
  -> bounded worker decode + transform
  -> Cesium-native geometry
  -> progressive render + verified terminal composition
```

`src/core`는 Cesium에 의존하지 않는 COPC 읽기·계층·range·cache 계층이고,
`src/cesium`은 좌표 변환·렌더러·layer·camera stream 계층이다. 예제 UI와
데모 정책은 `examples/basic-viewer`에 둔다.

- [API](API.md)
- [Architecture](ARCHITECTURE.md)
- [Sample provenance](DATASETS.md)
- [Performance and verification](PERFORMANCE.md)

## 재현

Node.js 22 환경에서:

```bash
npm ci
npm run dev
```

<http://localhost:3000>에서 원격 프리셋, Custom URL, 로컬 COPC를 확인한다.
전체 참가 장비 검증은 깨끗한 worktree에서 실행한다.

```bash
npm run qc:contest-device
npm run evidence:contest:check
```

GitHub의 일반 CI는 단위 테스트·빌드·라이선스와 기능 smoke를 검증한다.
실제 GPU 성능 근거는 target workstation에서 생성한 clean-commit evidence를
사용한다.

## 증거 산출물

`output/`은 Git에서 제외되며 다음 근거를 생성한다.

| 경로 | 의미 |
| --- | --- |
| `output/qc/qc-status.json` | 단계별 product/live QC 결과와 실패 분류 |
| `output/live-copc-range/live-copc-range.json` | 실제 `206`, `Content-Range`, 길이, `LASF` 검사 |
| `output/renderer-benchmark/renderers.json` | 실제 WebGL adapter 기반 renderer 반복 측정 |
| `output/smoothness-benchmark/*.json` | FPS, frame time, response, LOD, coverage, cache/worker/Range 근거 |
| `output/package-smoke/*` | 설치 가능한 tarball, checksum, consumer browser 결과 |
| `output/playwright/*.png` | Autzen, Millsite, 최종 기능 smoke 화면 |
| `output/contest-evidence/contest-evidence-manifest.json` | 현재 소스와 필수 산출물의 상태·크기·SHA-256 인덱스 |

매니페스트는 실패를 통과로 바꾸지 않는다. 누락·실패·source mismatch·생성
후 변경이 있으면 생성 또는 `--check`가 실패한다.

## 라이선스와 출처

- 자체 소스: [MIT](../LICENSE)
- 제3자 구성요소: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
- SPDX SBOM: [sbom.spdx.json](sbom.spdx.json)
- 샘플 데이터: [DATASETS.md](DATASETS.md)
- 보안 신고: [SECURITY.md](../SECURITY.md)

Autzen 데이터는 문서화된 CC BY 4.0 조건과 attribution을 따른다. Millsite는
공개 도메인 USGS 3DEP 컬렉션과 일치하는 Hobu 호스팅 COPC라는 한정된
출처 설명을 사용하며, 저장소와 npm 패키지에 데이터 바이트를 포함하지 않는다.

## 제한사항

- 현재 버전은 `0.1.0`이며 1.0 API 안정성을 선언하지 않는다.
- 외부 datum grid가 필요한 CRS는 application-provided transform이 필요하다.
- 브라우저 frame interval과 CPU-side timing은 전용 GPU profiler가 아니다.
- 편집, 비-COPC 형식, backend/hosting, 사전 변환은 지원 범위가 아니다.
- 더 많은 COPC 제작 도구·CRS·브라우저·하드웨어 검증이 필요하다.
