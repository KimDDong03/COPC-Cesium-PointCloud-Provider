# 2026 공개SW 개발자대회 과제 대응

이 문서는
[가이아쓰리디 공식 지정과제 설명](https://www.kossa.kr/materials/2026/ossp/tasks-gaia3d.html)에
명시된 COPC 데이터의 CesiumJS 직접 가시화 요구에 대한 `copc-cesium`의
구현·검증 근거를 한곳에 정리한다.

## 한 줄 결과

COPC URL 또는 브라우저의 로컬 파일을 3D Tiles로 사전 변환하지 않고
CesiumJS 장면에 직접 연결한다. COPC 옥트리 계층과 HTTP Range 요청을
이용해 현재 카메라에 필요한 점군을 단계적으로 선택·디코딩·렌더링하는
재사용 가능한 TypeScript 라이브러리다.

공개 심사용 참조 뷰어: <https://kimddong03.github.io/COPC_VIEWER/>

## 공모전 범위 경계

이 저장소의 공모전 대상은 COPC 데이터를 CesiumJS에 직접 가시화하는
TypeScript 라이브러리다. 성능·품질 근거는 라이브러리 코드, 브라우저
worker, COPC Range Read, Cesium-native 렌더링, 예제와 테스트에서만 나온다.

범위 안:

- COPC URL, `File`, `Blob` 입력의 직접 byte-range 읽기.
- COPC Octree, LoD, 필요한 hierarchy·point-data Range Read.
- 브라우저 worker, bounded cache, prefetch, request coalescing, cancellation.
- Cesium-native point renderer, 좌표 변환, 카메라 스트림 API.
- 재사용 가능한 라이브러리 API, 예제, 테스트, 벤치마크와 품질 검증.

범위 밖:

- AWS, CloudFront, S3 운영 구성 또는 배포 권고.
- CDN, edge 서버, backend proxy, 데이터 호스팅 제품.
- COPC를 3D Tiles나 다른 사전 타일링 포맷으로 변환하는 파이프라인.
- 외부 인프라, 호스팅 위치, CDN/edge 캐시를 라이브러리 성능 우위의
  근거로 삼는 주장.

문서와 벤치마크에서 등장하는 공개 S3 COPC URL은 테스트 입력 데이터일
뿐이다. 저장소의 GitHub Pages 배포는 정적 예제 접근성을 위한 지원 수단이며
런타임 의존성이나 성능 근거가 아니다. Opt-in IndexedDB persistent range
cache는 반복 방문을 위한 브라우저 라이브러리 기능으로 유지하지만, cold
load 성능이나 Eptium 대비 우위 근거로 사용하지 않는다.

## 2026 공식 일정과 제출 계약

기준일은 2026년 7월 14일이다. 일정은
[공개SW 포털의 대회 안내](https://www.oss.kr/pages/2),
[대회 공식 개요](https://osscontest.kr/overview),
[NIPA 공고](https://www.nipa.kr/home/bsnsAll/1/nttDetail?bbsNo=4&bsnsDtlsIemNo=58&nttNo=16815&tab=2)를
기준으로 하며, 서로 다른 마감 시간이 표시된 참가 접수는 더 이른 시각을
안전 기준으로 삼는다.

| 단계 | 공식 일정 | 이 저장소의 준비 기준 |
| --- | --- | --- |
| 참가 접수 | 6월 15일 ~ **7월 17일 18:00 안전 기준** | 참가자·팀 정보, 개발계획서, 정부지원 이력, 지정과제 선택을 접수 시스템에서 확인 |
| 오리엔테이션 | 7월 23일 | 공개되는 세부 평가표를 이 문서와 QC 기준에 즉시 반영 |
| 출품작 제출 | 7월 18일 ~ **8월 27일 18:00** | 편집 가능한 결과보고서와 PDF, 전체 소스코드, 3분 이내 YouTube 시연 URL 제출 |
| 1차 서면평가 | 9월 3일 ~ 9월 4일 | 보고서·소스·영상의 재현성과 과제 적합성 방어 |
| 기능·라이선스 검증 | 10월 12일 ~ 10월 28일 | `npm ci && npm run qc`, SBOM, 제3자 고지, 공개 저장소 검증 |
| 발표평가 | 11월 4일 ~ 11월 5일 | 3분 핵심 시연과 구조·성능·라이선스 질의 대응 |

현재 공개된 배점은 1차 서면 30점과 발표 70점이다. 세부 항목별 배점은
7월 23일 오리엔테이션 공개 예정이므로, 공개 전까지 임의의 항목별 점수를
공식 기준처럼 사용하지 않는다. 최신 공지는
[대회 공지판](https://osscontest.kr/notice)에서 다시 확인한다.

## 과제 적합성

| 과제 요구 방향 | 구현 근거 | 반복 검증 |
| --- | --- | --- |
| COPC 원본을 사전 타일링 없이 CesiumJS에 가시화 | `CopcSource`, `CopcPointCloudLayer`, URL·`File`/`Blob` 입력 | `npm run smoke:example:file` |
| COPC 내부 옥트리와 LoD 활용 | 카메라 프러스텀 기반 계층 확장, 화면 오차·점 간격 기반 complete-depth frontier 선택, additive ancestor 합성 | `npm run benchmark:smoothness:contest` |
| 필요한 영역·해상도 청크만 요청 | 엄격한 HTTP `206 Partial Content` Range getter, Blob slice, 요청 병합 및 제한형 캐시 | 단위 테스트와 URL 스모크 |
| 빠르고 부드러운 웹 가시화 | Worker 디코딩·geometry 준비, 최신 카메라 우선순위, 취소·backpressure·prefetch, 점 예산 | contest/cold/warm smoothness QC |
| CesiumJS용 라이브러리 또는 플러그인 | `copc-cesium`, `/core`, `/cesium` 공개 엔트리와 타입 선언 | `npm run smoke:package` |
| 다른 CesiumJS 앱에서 재사용 | 저수준 `CopcPointCloudLayer`와 고수준 `CopcPointCloudCameraStream` 분리 | 소비자 타입 검사·번들 빌드 |
| 공개SW 품질 | MIT, 변경 이력, 기여 가이드, CI, 릴리스 후보 산출물, 명시적 제한사항 | `npm run qc` |

## 운영규정 컴플라이언스

[2026 공식 운영규정](https://api.osscontest.kr/static/uploads/b3b4491a-3bbe-454e-a1d8-6ed475b01b14.pdf)은
전체 소스의 공개와 OSI 승인 라이선스, 사용한 외부 라이브러리·프레임워크의
출처 및 라이선스 공개를 요구한다. 저장소 차원의 증거와 참가자가 직접
확인해야 하는 정보를 분리한다.

| 항목 | 저장소 증거 | 제출 전 확인 |
| --- | --- | --- |
| 자체 코드 라이선스 | 루트 `LICENSE`의 MIT | 모든 신규 파일이 같은 정책을 따르는지 확인 |
| 제3자 소프트웨어·데이터 | `THIRD_PARTY_NOTICES.md`, `docs/sbom.spdx.json`, `docs/DATASETS.md`, 자동 라이선스 검사 | 배포 번들과 샘플의 별도 조건 재검토 |
| 공개·재현 가능 소스 | 공개 GitHub 저장소, lockfile, Node 22, `npm ci`, `npm run qc` | 제출 커밋 SHA와 공개 접근 권한 기록 |
| 팀 역할·기여도 | Git 이력과 PR/이슈 | 결과보고서에 실제 팀원별 역할·기여율 작성 |
| 중복수혜·권리 | 저장소만으로 판정 불가 | 정부지원 이력, 저작권, 대리개발 여부를 참가자가 직접 신고하고, 대회 진행 중 동일 프로젝트의 다른 정부지원 수상·지원금 수혜 사실을 알게 되면 7일 이내 주최 측에 신고 |
| AI 코딩 보조 | 생성 결과가 아닌 소스·테스트·근거를 심사 대상으로 유지 | 사용 사실과 사람이 검토·이해한 범위를 보고서에 정직하게 기재 |
| 공개 유지 | 현재 공개 저장소 | 수상 시 수상일부터 5년간 공개 유지 |
| 보안 신고 채널 | `SECURITY.md`와 비공개 권고 URL | GitHub Private vulnerability reporting을 활성화하고 외부 계정으로 접근 확인 |

결과보고서는
[공식 양식](https://api.osscontest.kr/static/uploads/46414fba-c473-4dae-b595-7214d635b494.zip)을
사용한다. 참가 접수, 팀 정보, 지원 이력, 영상 업로드처럼 저장소 밖에서만
완료할 수 있는 항목은 코드 완료와 별도로 관리해야 한다. 실행 순서는
[출품 체크리스트](https://github.com/KimDDong03/COPC_VIEWER/blob/main/docs/SUBMISSION_CHECKLIST_KO.md),
3분 구성은 [시연 구성안](https://github.com/KimDDong03/COPC_VIEWER/blob/main/docs/DEMO_SCRIPT_KO.md)에 고정한다.

운영규정 제15조 제2항에 따라 대회 진행 중 동일 프로젝트로 다른 정부지원
사업의 수상 또는 지원금 수혜 사실을 인지한 경우, 인지일로부터 7일 이내에
대회 주최 측에 신고한다. 결과보고서의 중복수혜 확인서는 제출 시점의 이력을
기록하는 절차이며, 이후 발생한 이 7일 신고 의무를 대신하지 않는다.

## 핵심 구조

```text
COPC URL / File / Blob
  -> exact byte-range getter
  -> metadata + hierarchy pages
  -> camera/frustum/LOD node selection
  -> bounded worker decode + coordinate transform
  -> Cesium-native point primitives
  -> interactive preview/refinement
  -> verified complete-depth additive terminal composition
```

`src/core`는 Cesium에 의존하지 않는 COPC 읽기·계층·캐시 계층이고,
`src/cesium`은 좌표 변환·렌더러·카메라 스트림 계층이다. 예제 뷰어의
정책과 UI는 `examples/basic-viewer`에 둔다. 자세한 구조는
[ARCHITECTURE.md](ARCHITECTURE.md), 공개 API는 [API.md](API.md)에 있다.

## 5분 재현

저장소를 설치하지 않고 확인할 때는
[공개 참조 뷰어](https://kimddong03.github.io/COPC_VIEWER/)를 연다. 이 URL은
정적 예제 배포 지원 수단이며 라이브러리 런타임 의존성이나 성능 우위의
근거가 아니다. `main`의 Pages workflow는 Vite 하위 경로, Cesium 정적 자산,
COPC worker와 LAZ WASM 경로를 검증한 뒤 배포한다. 최초 배포 전 저장소
소유자가 Pages 소스를 **GitHub Actions**로 선택해야 하며 workflow 자체는
저장소 설정을 변경하지 않는다.

```bash
npm ci
npm run dev
```

`http://localhost:3000`에서 Autzen과 USGS 3DEP Millsite Reservoir를 선택하고 카메라를
이동한다. coverage가 먼저 나타나고 detail이 이어지는지, 상태 패널에
LoD·캐시·prefetch 진단이 표시되는지 확인한다. 로컬 COPC 파일도 네트워크
URL과 동일한 레이어 API로 표시할 수 있다.

전체 자동 검증은 다음 한 명령으로 실행한다.

```bash
npm run qc:contest-device
```

이 명령은 먼저 단위 테스트, 라이브러리·예제 빌드, 라이선스/SBOM과 공백
검사로 구성된 결정적 제품 게이트를 실행한다. 이어 엄격한 원격 HTTP Range
사전 검사, 세 렌더러 비교, Autzen·Millsite 카메라 스트림 성능 게이트, cold
회귀, 설치 tarball의 실제 브라우저 실행, URL·로컬 파일 브라우저 스모크를
순차 실행한 뒤, 같은 장비의 세 개 새 브라우저 세션 중앙값을 검토된 다섯
세션 기준선과 비교한다. 외부 호스트나 네트워크가 응답하지 않으면 제품
회귀로 오인하지 않고 별도 분류 JSON과 종료 코드 2를 남기되, 최종 참가
장비 게이트 자체는 계속 통과로 처리하지 않는다.

GitHub `qc:release`는 기능 전용이며 SwiftShader 가능성 때문에 smoothness를
제외한다. 성능 근거는 clean RTX `qc:contest-device` 매니페스트만 사용한다.

최종 실행은 제출 커밋을 만든 뒤 변경 사항이 없는 깨끗한 Git worktree에서
수행해야 한다. 명령의 마지막 단계는 `npm run evidence:contest`로 증거
매니페스트를 생성하고 `npm run evidence:contest:check`로 현재 소스와 각
산출물의 바이트·SHA-256·상호 참조를 다시 확인한다. 이미 전체 QC 산출물이
준비되어 있다면 두 명령만 별도로 실행할 수도 있다.

## 심사 근거 산출물

검증 산출물은 Git에서 제외된 `output/` 아래에 생성된다.

| 산출물 | 의미 |
| --- | --- |
| `output/qc/qc-status.json` | 결정적 제품 게이트와 라이브 COPC 증거의 단계별 결과, 실패 단계, 외부 소스 불가/기능 회귀 분류 |
| `output/live-copc-range/live-copc-range.json` | Autzen·Millsite의 실제 HTTP 206, 정확한 `Content-Range`, 64바이트 길이와 `LASF` 서명 사전 검사 |
| `output/renderer-benchmark/renderers.json` | 세 Cesium 렌더러의 반복 측정, 실제 WebGL GPU, UTC·소스 지문·브라우저 버전 |
| `output/smoothness-benchmark/*.json` | 프리셋별 FPS, 프레임 간격, 최초 응답, LoD, 캐시·queue, `runEvidence`, additive closure·missing/stale node를 검사한 `cameraStreamVisualQuality` |
| `output/playwright/smoke-example-autzen-stream.png` | Autzen 색상 점군 스트리밍 가시화 증거 |
| `output/playwright/smoke-example-millsite-stream.png` | 공개 도메인 USGS 3DEP 컬렉션과 일치하는 Hobu 호스팅 Millsite COPC의 카메라 스트림 가시화 증거 |
| `output/playwright/smoke-example-final-verification.png` | Custom URL 또는 로컬 파일 최종 스모크 상태 |
| `output/package-smoke/*.tgz` | 소비자 타입 검사와 빌드를 통과한 npm 패키지 후보 |
| `output/package-smoke/browser-result.json` | 설치 tarball로 실행한 Cesium Viewer·worker COPC 렌더와 브라우저 오류 검사 |
| `output/smoothness-benchmark/regression-sessions/*.json` | 세 개 새 브라우저 세션과 다섯 세션 기준선 비교 근거 |
| `output/contest-evidence/contest-evidence-manifest.json` | 현재 clean commit의 `runEvidence`와 필수 JSON·PNG·tarball·체크섬·회귀 세션의 크기 및 SHA-256을 묶고, 서로 참조하는 패키지·스크린샷 계약까지 검증한 최종 제출 인덱스 |

매니페스트가 있다고 해서 누락되거나 실패한 결과가 통과로 바뀌지는 않는다.
필수 상태가 성공이 아니거나, JSON의 `runEvidence`가 현재 커밋과 다르거나,
패키지·체크섬·스크린샷 바이트가 생성 후 바뀌면 생성 또는 `--check` 단계가
실패한다.

브라우저 결과에는 `browserGraphics.vendor`, `renderer`, `version`이
기록된다. Chromium에는 고성능 GPU 사용을 요청하지만 장치 번호(`GPU 0`,
`GPU 1`)를 추측하지 않고 실제 WebGL 렌더러를 성능 결과의 기준으로 쓴다.
같은 기준선 비교는 실제 WebGL vendor/renderer/version, 브라우저 계약, 절대
임계값 집합이 일치할 때만 허용한다.

## 정직한 제한사항

- 현재 버전은 `0.1.0`이며 1.0 API 안정성을 선언하지 않는다.
- COPC WKT가 외부 datum grid를 요구하면 명시적 변환을 제공해야 한다.
- 브라우저 프레임 간격과 CPU 제출 시간을 계측하지만 전용 GPU profiler는 아니다.
- 편집, 영구 오프라인 캐시, 비-COPC 형식, 도메인별 스타일은 범위 밖이다.
- 더 많은 COPC 제작 도구·CRS·브라우저·저사양 장치 표본이 필요하다.

완전한 타입 검사 예시는
[`examples/minimal-layer.ts`](../examples/minimal-layer.ts)에 있다. 상세한
성능 측정법과 임계값은 [PERFORMANCE.md](PERFORMANCE.md)에 있다.
