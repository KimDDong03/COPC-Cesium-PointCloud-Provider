export async function runEptiumComparisonBrowserFlow(page, configuration) {
  const sourceRequests = [];
  const sourceResponses = [];
  const eptiumAppResponses = [];
  const consoleProblems = [];
  const pageErrors = [];
  const captures = [];
  const sourceRequestState = new WeakMap();
  const pendingSourceRequestFinalizers = new Set();
  let evidenceScope = "startup";

  page.on("request", (request) => {
    if (request.url() !== configuration.sourceUrl) {
      return;
    }
    const record = {
      scope: evidenceScope,
      url: request.url(),
      requestRange: request.headers().range,
      method: request.method(),
      resourceType: request.resourceType(),
      startedAtMilliseconds: Date.now(),
      outcome: "pending",
    };
    sourceRequests.push(record);
    sourceRequestState.set(request, record);
  });

  page.on("console", (message) => {
    const type = message.type();
    const text = message.text();
    const expectedDriverWarning =
      type === "warning" &&
      /^\[\.WebGL-[^\]]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/.test(
        text,
      );
    if (!expectedDriverWarning && (type === "error" || type === "warning")) {
      consoleProblems.push({ scope: evidenceScope, type, text });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push({ scope: evidenceScope, message: error.message });
  });
  page.on("response", (response) => {
    if (/^https:\/\/eptium\.com\/assets\/(?:main|chunk)-/i.test(response.url())) {
      const headers = response.headers();
      eptiumAppResponses.push({
        scope: evidenceScope,
        url: response.url(),
        status: response.status(),
        etag: headers.etag,
        lastModified: headers["last-modified"],
        contentLength: headers["content-length"],
      });
    }
    if (response.url() !== configuration.sourceUrl) {
      return;
    }
    const request = response.request();
    const requestRecord = sourceRequestState.get(request);
    const headers = response.headers();
    const responseRecord = {
      scope: requestRecord?.scope ?? evidenceScope,
      url: response.url(),
      status: response.status(),
      requestRange: requestRecord?.requestRange ?? request.headers().range,
      etag: headers.etag,
      lastModified: headers["last-modified"],
      contentRange: headers["content-range"],
      rangeContentLength: headers["content-length"],
      acceptRanges: headers["accept-ranges"],
      fromServiceWorker:
        typeof response.fromServiceWorker === "function"
          ? response.fromServiceWorker()
          : undefined,
    };
    sourceResponses.push(responseRecord);
    if (requestRecord) {
      Object.assign(requestRecord, responseRecord, {
        responseObservedAtMilliseconds: Date.now(),
      });
    }
  });
  page.on("requestfinished", (request) => {
    const record = sourceRequestState.get(request);
    if (!record) {
      return;
    }
    const finalizer = finalizeSourceRequest(request, record);
    pendingSourceRequestFinalizers.add(finalizer);
    void finalizer.finally(() => pendingSourceRequestFinalizers.delete(finalizer));
  });
  page.on("requestfailed", (request) => {
    const record = sourceRequestState.get(request);
    if (!record) {
      return;
    }
    const failure = request.failure();
    record.outcome = "failed";
    record.failure =
      typeof failure === "string" ? failure : failure?.errorText ?? "unknown";
    record.finishedAtMilliseconds = Date.now();
    record.durationMilliseconds =
      record.finishedAtMilliseconds - record.startedAtMilliseconds;
    record.timing = readRequestTiming(request);
  });

  const eptiumUrl =
    configuration.eptiumBaseUrl +
    "/?copc=" +
    encodeURIComponent(configuration.sourceUrl);

  evidenceScope = "eptium-calibration";
  await page.goto(eptiumUrl, { waitUntil: "domcontentloaded" });
  await waitForEptiumViewer(page, configuration.sourceUrl);
  // Eptium asynchronously fits the source after construction. Wait for that
  // fit to settle before applying the shared benchmark pose.
  await waitForEptiumTerminal(page, configuration.sourceUrl);
  const calibrations = [];
  for (const screenSpaceError of configuration.calibrationScreenSpaceErrors) {
    await setEptiumCameraPose(
      page,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      screenSpaceError,
    );
    calibrations.push(
      await waitForEptiumTerminal(
        page,
        configuration.sourceUrl,
        configuration.cameraPoseFingerprint,
        screenSpaceError,
      ),
    );
  }
  const stockCalibration = calibrations.find(
    (calibration) =>
      calibration.screenSpaceError === configuration.stockScreenSpaceError,
  );
  if (!stockCalibration) {
    throw new Error("Eptium stock SSE was not included in calibration.");
  }
  const eptiumRuntime = await page.evaluate(() => ({
    pageUrl: location.href,
    title: document.title,
    scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
    cesiumVersion: window.Cesium?.VERSION ?? null,
    viewerConstructor: window.viewer?.constructor?.name ?? null,
  }));

  const configurations = [
    {
      id: "eptium-stock",
      vendor: "eptium",
      screenSpaceError: configuration.stockScreenSpaceError,
      expectedPointCount: stockCalibration.pointCount,
    },
    {
      id: "ours-shipped-default",
      vendor: "ours",
      quality: "balanced",
      pointBudget: configuration.oursBalancedPointBudgetOverride,
    },
    {
      id: "ours-high-detail",
      vendor: "ours",
      quality: "detail",
      pointBudget: configuration.oursDetailPointBudgetOverride,
    },
    {
      id: "ours-equal-count",
      vendor: "ours",
      quality: "detail",
      pointBudget: stockCalibration.pointCount,
    },
  ];
  const capturePlan = [];
  for (let repeat = 1; repeat <= configuration.repeats; repeat += 1) {
    const ordered =
      repeat % 2 === 1 ? configurations : [...configurations].reverse();
    for (const captureConfiguration of ordered) {
      capturePlan.push({
        ...captureConfiguration,
        repeat,
        order: capturePlan.length + 1,
        captureId: captureConfiguration.id + "-r" + repeat,
      });
    }
  }

  for (const capture of capturePlan) {
    const paths = configuration.capturePaths[capture.captureId];
    if (!paths) {
      throw new Error("Missing output paths for " + capture.captureId + ".");
    }
    const result =
      capture.vendor === "eptium"
        ? await captureEptium(page, capture, paths)
        : await captureOurs(page, capture, paths);
    captures.push(result);
  }

  await transitionEvidenceScope("complete");
  await page.waitForTimeout(0);
  await waitForSourceRequestFinalizers();

  return {
    browserSessionId: configuration.browserSessionId,
    calibration: {
      samples: calibrations,
      stock: stockCalibration,
    },
    eptiumRuntime,
    capturePlan,
    captures,
    sourceRequests,
    sourceResponses,
    eptiumAppResponses,
    consoleProblems,
    pageErrors,
  };

  async function finalizeSourceRequest(request, record) {
    record.outcome = "finished";
    record.finishedAtMilliseconds = Date.now();
    record.durationMilliseconds =
      record.finishedAtMilliseconds - record.startedAtMilliseconds;
    record.timing = readRequestTiming(request);
    if (typeof request.sizes === "function") {
      try {
        record.sizes = await request.sizes();
      } catch (error) {
        record.sizeReadError = String(error);
      }
    }
  }

  async function waitForSourceRequestFinalizers() {
    while (pendingSourceRequestFinalizers.size > 0) {
      await Promise.all([...pendingSourceRequestFinalizers]);
    }
  }

  async function transitionEvidenceScope(nextScope) {
    await page.waitForTimeout(50);
    await waitForSourceRequestFinalizers();
    for (const request of sourceRequests) {
      if (request.scope !== evidenceScope || request.outcome !== "pending") {
        continue;
      }
      request.outcome = "abandoned";
      request.abandonReason = "scope-closed-before-requestfinished";
      request.finishedAtMilliseconds = Date.now();
      request.durationMilliseconds =
        request.finishedAtMilliseconds - request.startedAtMilliseconds;
    }
    evidenceScope = nextScope;
  }

  function readRequestTiming(request) {
    if (typeof request.timing !== "function") {
      return undefined;
    }
    try {
      return request.timing();
    } catch {
      return undefined;
    }
  }

  async function captureEptium(activePage, capture, paths) {
    const productScope = capture.captureId + ":product";
    await transitionEvidenceScope(productScope);
    const captureStartedAt = Date.now();
    await activePage.goto(eptiumUrl, { waitUntil: "domcontentloaded" });
    const navigationReadyAt = Date.now();
    await waitForEptiumViewer(activePage, configuration.sourceUrl);
    const viewerReadyAt = Date.now();
    const initialTerminal = await waitForEptiumTerminal(
      activePage,
      configuration.sourceUrl,
    );
    const initialTerminalAt = Date.now();
    const sharedPoseStartedAt = Date.now();
    await setEptiumCameraPose(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    const sharedPoseTerminal = await waitForEptiumTerminal(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    const sharedPoseTerminalAt = Date.now();
    const loadTiming = {
      semantics:
        "fresh page navigation in one shared browser session; HTTP cache state is observed, not forcibly cleared",
      navigationReadyMilliseconds: navigationReadyAt - captureStartedAt,
      viewerReadyMilliseconds: viewerReadyAt - captureStartedAt,
      initialFirstTerminalMilliseconds:
        initialTerminalAt -
        initialTerminal.terminalObservation.stableWaitMilliseconds -
        captureStartedAt,
      initialStableTerminalMilliseconds: initialTerminalAt - captureStartedAt,
      sharedPoseFirstTerminalMilliseconds:
        sharedPoseTerminalAt -
        sharedPoseTerminal.terminalObservation.stableWaitMilliseconds -
        sharedPoseStartedAt,
      sharedPoseStableTerminalMilliseconds:
        sharedPoseTerminalAt - sharedPoseStartedAt,
      productFirstReadyMilliseconds:
        sharedPoseTerminalAt -
        sharedPoseTerminal.terminalObservation.stableWaitMilliseconds -
        captureStartedAt,
      productReadyMilliseconds: sharedPoseTerminalAt - captureStartedAt,
    };
    const stockSettings = await readEptiumSettings(
      activePage,
      configuration.sourceUrl,
    );
    const isolatedScene = await isolateEptiumScene(activePage);
    const discardedFairnessWarmup = await measureEptiumPostRender(
      activePage,
      configuration.sourceUrl,
      configuration.fairTargetFrameRate,
    );
    await setEptiumCameraPose(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    await waitForEptiumTerminal(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    const fairnessPerformance = await measureEptiumPostRender(
      activePage,
      configuration.sourceUrl,
      configuration.fairTargetFrameRate,
    );
    await setEptiumCameraPose(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    await waitForEptiumTerminal(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    const stockPerformance = await measureEptiumPostRender(
      activePage,
      configuration.sourceUrl,
      stockSettings.targetFrameRate,
    );
    await setEptiumCameraPose(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    const terminal = await waitForEptiumTerminal(
      activePage,
      configuration.sourceUrl,
      configuration.cameraPoseFingerprint,
      capture.screenSpaceError,
    );
    const browserGraphics = await readBrowserGraphics(activePage, "eptium");
    const cleanCapture = await prepareCleanCanvasCapture(activePage, "eptium");
    const canvas = activePage.locator("#external-comparison-canvas");
    await canvas.screenshot({ path: paths.visualOutputImagePath });
    await setEptiumGeometryMaskVisibility(
      activePage,
      configuration.sourceUrl,
      false,
    );
    const pointOffCleanCapture = await readCleanCanvasCaptureState(activePage);
    await canvas.screenshot({ path: paths.backgroundImagePath });
    await setEptiumGeometryMaskVisibility(
      activePage,
      configuration.sourceUrl,
      true,
    );
    await canvas.screenshot({ path: paths.pointImagePath });
    await setEptiumGeometryMaskVisibility(
      activePage,
      configuration.sourceUrl,
      false,
    );
    const pointOffVerificationCleanCapture =
      await readCleanCanvasCaptureState(activePage);
    await canvas.screenshot({ path: paths.backgroundVerificationImagePath });
    return {
      ...capture,
      paths,
      status: terminal,
      settings: stockSettings,
      metricMode: "geometry-mask/EDL-off",
      pointOffMechanism: "Cesium3DTileStyle.show=false/makeStyleDirty",
      isolatedScene,
      metricIsolatedScene: isolatedScene,
      performance: {
        discardedFairnessWarmup,
        stock: stockPerformance,
        fairness: fairnessPerformance,
      },
      loadTiming,
      networkScopes: { product: productScope },
      browserGraphics,
      cleanCapture,
      pointOffCleanCapture,
      pointOffVerificationCleanCapture,
    };
  }

  async function captureOurs(activePage, capture, paths) {
    const productScope = capture.captureId + ":product";
    const geometryMaskScope = capture.captureId + ":geometry-mask";
    await transitionEvidenceScope(productScope);
    const captureStartedAt = Date.now();
    let oursUrl =
      configuration.oursBaseUrl +
      "/?renderer=typed&visualBenchmark=1&renderVariant=enhanced";
    if (capture.quality === "detail") {
      oursUrl += "&quality=detail";
    }
    if (capture.pointBudget !== undefined) {
      oursUrl +=
        "&cameraStreamMaxPoints=" + encodeURIComponent(capture.pointBudget);
    }
    await activePage.goto(oursUrl, { waitUntil: "domcontentloaded" });
    const navigationReadyAt = Date.now();
    await activePage.waitForFunction(
      () => window.__copcBasicViewerBenchmark !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    const viewerReadyAt = Date.now();
    const initialTerminalStartedAt = Date.now();
    await waitForOursTerminal(activePage);
    const initialTerminalAt = Date.now();
    const isolatedScene = await activePage.evaluate(() =>
      window.__copcBasicViewerBenchmark.isolateSceneForVisualBenchmark(),
    );
    const sharedPoseStartedAt = Date.now();
    await activePage.evaluate(async (fingerprint) => {
      await window.__copcBasicViewerBenchmark.setCameraPoseForVisualBenchmark(
        fingerprint,
      );
    }, configuration.cameraPoseFingerprint);
    await waitForOursTerminal(activePage);
    const sharedPoseTerminalAt = Date.now();
    const loadTiming = {
      semantics:
        "fresh page navigation in one shared browser session; HTTP cache state is observed, not forcibly cleared",
      navigationReadyMilliseconds: navigationReadyAt - captureStartedAt,
      viewerReadyMilliseconds: viewerReadyAt - captureStartedAt,
      initialFirstTerminalMilliseconds: initialTerminalAt - captureStartedAt,
      initialTerminalWaitMilliseconds:
        initialTerminalAt - initialTerminalStartedAt,
      sharedPoseFirstTerminalMilliseconds:
        sharedPoseTerminalAt - sharedPoseStartedAt,
      sharedPoseStableTerminalMilliseconds:
        sharedPoseTerminalAt - sharedPoseStartedAt,
      productFirstReadyMilliseconds: sharedPoseTerminalAt - captureStartedAt,
      productReadyMilliseconds: sharedPoseTerminalAt - captureStartedAt,
    };
    const discardedFairnessWarmup = await activePage.evaluate(
      async ({ fairTargetFrameRate, movement }) =>
        window.__copcBasicViewerBenchmark.measurePostRenderForVisualBenchmark({
          ...movement,
          targetFrameRate: fairTargetFrameRate,
        }),
      {
        fairTargetFrameRate: configuration.fairTargetFrameRate,
        movement: configuration.performanceMovement,
      },
    );
    await activePage.evaluate(async (fingerprint) => {
      await window.__copcBasicViewerBenchmark.setCameraPoseForVisualBenchmark(
        fingerprint,
      );
    }, configuration.cameraPoseFingerprint);
    await waitForOursTerminal(activePage);
    const fairnessMeasurement = await activePage.evaluate(
      async ({ fairTargetFrameRate, movement }) =>
        window.__copcBasicViewerBenchmark.measurePostRenderForVisualBenchmark({
          ...movement,
          targetFrameRate: fairTargetFrameRate,
        }),
      {
        fairTargetFrameRate: configuration.fairTargetFrameRate,
        movement: configuration.performanceMovement,
      },
    );
    await activePage.evaluate(async (fingerprint) => {
      await window.__copcBasicViewerBenchmark.setCameraPoseForVisualBenchmark(
        fingerprint,
      );
    }, configuration.cameraPoseFingerprint);
    const stockStatus = await waitForOursTerminal(activePage);
    const stockWorkloadStatus = summarizeOursWorkloadStatus(stockStatus);
    const stockBrowserGraphics = await readBrowserGraphics(activePage, "ours");
    await prepareCleanCanvasCapture(activePage, "ours");
    await activePage
      .locator("#external-comparison-canvas")
      .screenshot({ path: paths.visualOutputImagePath });

    const geometryMaskUrl = oursUrl + "&geometryMaskBenchmark=1";
    await transitionEvidenceScope(geometryMaskScope);
    const geometryMaskStartedAt = Date.now();
    await activePage.goto(geometryMaskUrl, { waitUntil: "domcontentloaded" });
    await activePage.waitForFunction(
      () => window.__copcBasicViewerBenchmark !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    await waitForOursTerminal(activePage);
    const metricIsolatedScene = await activePage.evaluate(() =>
      window.__copcBasicViewerBenchmark.isolateSceneForVisualBenchmark(),
    );
    await activePage.evaluate(async (fingerprint) => {
      await window.__copcBasicViewerBenchmark.setCameraPoseForVisualBenchmark(
        fingerprint,
      );
    }, configuration.cameraPoseFingerprint);
    const status = summarizeOursWorkloadStatus(
      await waitForOursTerminal(activePage),
    );
    const geometryMaskReadyAt = Date.now();
    const browserGraphics = await readBrowserGraphics(activePage, "ours");
    const cleanCapture = await prepareCleanCanvasCapture(activePage, "ours");
    const canvas = activePage.locator("#external-comparison-canvas");
    await canvas.screenshot({ path: paths.pointImagePath });
    const clearedRevision = await activePage.evaluate(() =>
      window.__copcBasicViewerBenchmark.clearPointCloudForVisualBenchmark(),
    );
    await activePage.evaluate(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const pointOffCleanCapture = await readCleanCanvasCaptureState(activePage);
    await canvas.screenshot({ path: paths.backgroundImagePath });
    await settlePointOffCanvas(activePage, "ours");
    const pointOffVerificationCleanCapture =
      await readCleanCanvasCaptureState(activePage);
    await canvas.screenshot({ path: paths.backgroundVerificationImagePath });
    return {
      ...capture,
      paths,
      status,
      stockWorkloadStatus,
      settings: {
        renderer: "typed",
        renderVariant: stockStatus.rendererQualityVariant,
        quality: capture.quality,
        configuredPointBudget: capture.pointBudget,
        cameraStreamLod: stockStatus.cameraStreamLodData,
        targetFrameRate: configuration.fairTargetFrameRate,
      },
      isolatedScene,
      metricIsolatedScene,
      metricMode: "geometry-mask/EDL-off",
      pointOffMechanism: "clearPointCloudForVisualBenchmark",
      performance: {
        discardedFairnessWarmup:
          discardedFairnessWarmup.performance,
        fairness: fairnessMeasurement.performance,
      },
      loadTiming,
      measurementReloadTiming: {
        geometryMaskReadyMilliseconds:
          geometryMaskReadyAt - geometryMaskStartedAt,
      },
      networkScopes: {
        product: productScope,
        measurement: geometryMaskScope,
      },
      browserGraphics,
      stockBrowserGraphics,
      cleanCapture,
      pointOffCleanCapture,
      pointOffVerificationCleanCapture,
      clearedRevision,
    };
  }

  async function setEptiumGeometryMaskVisibility(
    activePage,
    sourceUrl,
    visible,
  ) {
    await activePage.evaluate(
      async ({ sourceUrl: expectedUrl, visible: nextVisible }) => {
        const viewer = window.viewer;
        const matchingTilesets = Array.from(
          { length: viewer.scene.primitives.length },
          (_, index) => viewer.scene.primitives.get(index),
        ).filter((primitive) => primitive?._url === expectedUrl);
        if (matchingTilesets.length !== 1) {
          throw new Error(
            `Expected exactly one Eptium tileset for geometry-mask visibility, found ${matchingTilesets.length}.`,
          );
        }
        const tileset = matchingTilesets[0];
        if (!tileset.style || typeof tileset.makeStyleDirty !== "function") {
          throw new Error("Eptium style counterfactual is unavailable.");
        }
        tileset.pointCloudShading.eyeDomeLighting = false;
        tileset.style.show = nextVisible;
        tileset.makeStyleDirty();
        await new Promise((resolve, reject) => {
          let rendered = 0;
          const timeout = setTimeout(() => {
            remove();
            reject(new Error("Timed out applying Eptium geometry-mask style."));
          }, 10_000);
          const remove = viewer.scene.postRender.addEventListener(() => {
            rendered += 1;
            if (rendered >= 3) {
              clearTimeout(timeout);
              remove();
              resolve();
            } else {
              viewer.scene.requestRender();
            }
          });
          viewer.scene.requestRender();
        });
      },
      { sourceUrl, visible },
    );
  }

  function summarizeOursWorkloadStatus(status) {
    return {
      cameraPoseFingerprint: status.cameraStreamCameraPoseFingerprint,
      pointCount: status.cameraStreamRenderedPointCount,
      canvasDrawingBufferWidth: status.canvasDrawingBufferWidth,
      canvasDrawingBufferHeight: status.canvasDrawingBufferHeight,
      devicePixelRatio: status.devicePixelRatio,
      renderSignature: status.cameraStreamRenderSignature,
      selectedNodeKeys: status.cameraStreamSelectedNodeKeys,
      terminalReady: status.cameraStreamVisualQuality?.isTerminalReady,
      detailComplete: status.cameraStreamDetailProgress?.isComplete,
    };
  }

  async function waitForOursTerminal(activePage) {
    await activePage.waitForFunction(
      () => {
        const status = window.__copcBasicViewerBenchmark?.getStatus();
        return (
          status?.cameraStreamVisualQuality?.isTerminalReady === true &&
          status?.cameraStreamDetailProgress?.isComplete === true &&
          Number.isSafeInteger(status.cameraStreamRenderedPointCount) &&
          status.cameraStreamRenderedPointCount > 0
        );
      },
      undefined,
      { timeout: 180_000 },
    );
    return activePage.evaluate(() =>
      window.__copcBasicViewerBenchmark.getStatus(),
    );
  }

  async function waitForEptiumViewer(activePage, sourceUrl) {
    await activePage.waitForFunction(
      (expectedUrl) => {
        const viewer = window.viewer;
        if (!viewer) return false;
        return Array.from(
          { length: viewer.scene.primitives.length },
          (_, index) => viewer.scene.primitives.get(index),
        ).some((primitive) => primitive?._url === expectedUrl);
      },
      sourceUrl,
      { timeout: 120_000 },
    );
  }

  async function setEptiumScreenSpaceError(activePage, sourceUrl, value) {
    await activePage.evaluate(
      ({ sourceUrl: expectedUrl, value: nextValue }) => {
        const viewer = window.viewer;
        const matchingTilesets = Array.from(
          { length: viewer.scene.primitives.length },
          (_, index) => viewer.scene.primitives.get(index),
        ).filter((primitive) => primitive?._url === expectedUrl);
        if (matchingTilesets.length !== 1) {
          throw new Error(`Expected one Eptium tileset, found ${matchingTilesets.length}.`);
        }
        const tileset = matchingTilesets[0];
        tileset.maximumScreenSpaceError = nextValue;
        tileset.show = true;
        viewer.scene.requestRender();
      },
      { sourceUrl, value },
    );
  }

  async function setEptiumCameraPose(
    activePage,
    sourceUrl,
    fingerprint,
    screenSpaceError,
  ) {
    await activePage.evaluate(
      ({ sourceUrl: expectedUrl, fingerprint: value, screenSpaceError: sse }) => {
        const values = value.split("|").map(Number);
        if (values.length !== 21 || values.some((entry) => !Number.isFinite(entry))) {
          throw new Error("External camera pose must contain 21 finite values.");
        }
        const viewer = window.viewer;
        const matchingTilesets = Array.from(
          { length: viewer.scene.primitives.length },
          (_, index) => viewer.scene.primitives.get(index),
        ).filter((primitive) => primitive?._url === expectedUrl);
        if (matchingTilesets.length !== 1) {
          throw new Error(`Expected one Eptium tileset, found ${matchingTilesets.length}.`);
        }
        const tileset = matchingTilesets[0];
        tileset.maximumScreenSpaceError = sse;
        tileset.show = true;
        viewer.camera.frustum.fov = values[17];
        viewer.camera.frustum.aspectRatio = values[18];
        viewer.camera.frustum.near = values[19];
        viewer.camera.frustum.far = values[20];
        viewer.camera.setView({
          destination: { x: values[0], y: values[1], z: values[2] },
          orientation: {
            direction: { x: values[3], y: values[4], z: values[5] },
            up: { x: values[6], y: values[7], z: values[8] },
          },
        });
        viewer.scene.requestRender();
      },
      { sourceUrl, fingerprint, screenSpaceError },
    );
  }

  async function waitForEptiumTerminal(
    activePage,
    sourceUrl,
    expectedCameraPoseFingerprint,
    expectedScreenSpaceError,
  ) {
    const waitStartedAt = Date.now();
    await activePage.waitForFunction(
      (expectedUrl) => {
        const viewer = window.viewer;
        const matchingTilesets = viewer
          ? Array.from(
              { length: viewer.scene.primitives.length },
              (_, index) => viewer.scene.primitives.get(index),
            ).filter((primitive) => primitive?._url === expectedUrl)
          : [];
        const tileset = matchingTilesets[0];
        const statistics = tileset?._statistics;
        return (
          matchingTilesets.length === 1 &&
          tileset?.tilesLoaded === true &&
          statistics?.numberOfPendingRequests === 0 &&
          statistics?.numberOfTilesProcessing === 0 &&
          statistics?.numberOfPointsSelected > 0
        );
      },
      sourceUrl,
      { timeout: 180_000 },
    );
    const firstReadyAt = Date.now();

    let stableCount = 0;
    let previousSignature;
    let state;
    const deadline = Date.now() + 30_000;
    while (stableCount < 8) {
      if (Date.now() >= deadline) {
        throw new Error("Eptium terminal statistics did not remain stable.");
      }
      state = await readEptiumTerminalState(activePage, sourceUrl);
      const signature =
        state.pointCount +
        "|" +
        state.selectedTileCount +
        "|" +
        state.cameraPoseFingerprint +
        "|" +
        state.screenSpaceError;
      const terminal =
        state.tilesLoaded === true &&
        state.pendingRequestCount === 0 &&
        state.processingTileCount === 0 &&
        (expectedScreenSpaceError === undefined ||
          state.screenSpaceError === expectedScreenSpaceError) &&
        (expectedCameraPoseFingerprint === undefined ||
          cameraPoseMatches(
            expectedCameraPoseFingerprint,
            state.cameraPoseFingerprint,
          ));
      stableCount = terminal && signature === previousSignature
        ? stableCount + 1
        : terminal
          ? 1
          : 0;
      previousSignature = signature;
      if (stableCount < 8) {
        await activePage.waitForTimeout(100);
      }
    }
    const stableReadyAt = Date.now();
    return {
      ...state,
      terminalObservation: {
        firstReadyWaitMilliseconds: firstReadyAt - waitStartedAt,
        stableWaitMilliseconds: stableReadyAt - firstReadyAt,
        totalWaitMilliseconds: stableReadyAt - waitStartedAt,
        stableSampleCount: stableCount,
        stableSampleIntervalMilliseconds: 100,
      },
    };
  }

  function cameraPoseMatches(expectedFingerprint, actualFingerprint) {
    const expected = expectedFingerprint.split("|").map(Number);
    const actual = actualFingerprint.split("|").map(Number);
    if (
      expected.length !== 21 ||
      actual.length !== 21 ||
      expected.some((value) => !Number.isFinite(value)) ||
      actual.some((value) => !Number.isFinite(value))
    ) {
      return false;
    }
    const maximumDelta = (start, end) =>
      expected.slice(start, end).reduce(
        (maximum, value, index) =>
          Math.max(maximum, Math.abs(value - actual[start + index])),
        0,
      );
    const projectionRelativeDelta = expected.slice(17).reduce(
      (maximum, value, index) => {
        const candidate = actual[index + 17];
        const scale = Math.max(1, Math.abs(value), Math.abs(candidate));
        return Math.max(maximum, Math.abs(value - candidate) / scale);
      },
      0,
    );
    return (
      maximumDelta(0, 3) <= 0.00001 &&
      maximumDelta(3, 12) <= 1e-12 &&
      expected
        .slice(12, 17)
        .every((value, index) => value === actual[index + 12]) &&
      projectionRelativeDelta <= 1e-12
    );
  }

  async function readEptiumTerminalState(activePage, sourceUrl) {
    return activePage.evaluate((expectedUrl) => {
      const viewer = window.viewer;
      const matchingTilesets = Array.from(
        { length: viewer.scene.primitives.length },
        (_, index) => viewer.scene.primitives.get(index),
      ).filter((primitive) => primitive?._url === expectedUrl);
      if (matchingTilesets.length !== 1) {
        throw new Error(
          `Expected exactly one Eptium tileset, found ${matchingTilesets.length}.`,
        );
      }
      const tileset = matchingTilesets[0];
      const statistics = tileset._statistics;
      return {
        sourceUrl: tileset._url,
        cameraPoseFingerprint: createFingerprint(viewer),
        screenSpaceError: tileset.maximumScreenSpaceError,
        pointCount: statistics.numberOfPointsSelected,
        loadedPointCount: statistics.numberOfPointsLoaded,
        selectedTileCount: statistics.selected,
        selectedTilesLength: tileset._selectedTiles?.length,
        visitedTileCount: statistics.visited,
        pendingRequestCount: statistics.numberOfPendingRequests,
        processingTileCount: statistics.numberOfTilesProcessing,
        tilesLoaded: tileset.tilesLoaded,
        canvasDrawingBufferWidth: viewer.scene.canvas.width,
        canvasDrawingBufferHeight: viewer.scene.canvas.height,
        devicePixelRatio: window.devicePixelRatio,
      };

      function createFingerprint(activeViewer) {
        const camera = activeViewer.camera;
        const canvas = activeViewer.scene.canvas;
        return [
          camera.positionWC.x,
          camera.positionWC.y,
          camera.positionWC.z,
          camera.directionWC.x,
          camera.directionWC.y,
          camera.directionWC.z,
          camera.upWC.x,
          camera.upWC.y,
          camera.upWC.z,
          camera.rightWC.x,
          camera.rightWC.y,
          camera.rightWC.z,
          canvas.clientWidth,
          canvas.clientHeight,
          canvas.width,
          canvas.height,
          window.devicePixelRatio,
          camera.frustum.fov,
          camera.frustum.aspectRatio,
          camera.frustum.near,
          camera.frustum.far,
        ]
          .map((entry) =>
            typeof entry === "number" && Number.isFinite(entry)
              ? entry.toPrecision(15)
              : String(entry),
          )
          .join("|");
      }
    }, sourceUrl);
  }

  async function isolateEptiumScene(activePage) {
    return activePage.evaluate(() => {
      const viewer = window.viewer;
      const background = viewer.scene.backgroundColor;
      background.red = 0;
      background.green = 0;
      background.blue = 0;
      background.alpha = 1;
      viewer.scene.globe.show = false;
      viewer.scene.globe.showGroundAtmosphere = false;
      viewer.scene.fog.enabled = false;
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
      if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
      if (viewer.scene.sun) viewer.scene.sun.show = false;
      if (viewer.scene.moon) viewer.scene.moon.show = false;
      viewer.scene.requestRender();
      return {
        background: "opaque-black",
        globeShown: viewer.scene.globe.show,
        atmosphereShown: viewer.scene.skyAtmosphere?.show ?? false,
        skyBoxShown: viewer.scene.skyBox?.show ?? false,
        sunShown: viewer.scene.sun?.show ?? false,
        moonShown: viewer.scene.moon?.show ?? false,
        fogEnabled: viewer.scene.fog.enabled,
      };
    });
  }

  async function readEptiumSettings(activePage, sourceUrl) {
    return activePage.evaluate((expectedUrl) => {
      const viewer = window.viewer;
      const tileset = Array.from(
        { length: viewer.scene.primitives.length },
        (_, index) => viewer.scene.primitives.get(index),
      ).find((primitive) => primitive?._url === expectedUrl);
      const shading = tileset.pointCloudShading;
      return {
        targetFrameRate: viewer.targetFrameRate,
        msaaSamples: viewer.scene.msaaSamples,
        fxaaEnabled: viewer.scene.postProcessStages.fxaa.enabled,
        maximumScreenSpaceError: tileset.maximumScreenSpaceError,
        skipLevelOfDetail: tileset.skipLevelOfDetail,
        immediatelyLoadDesiredLevelOfDetail:
          tileset.immediatelyLoadDesiredLevelOfDetail,
        loadSiblings: tileset.loadSiblings,
        preferLeaves: tileset.preferLeaves,
        preloadWhenHidden: tileset.preloadWhenHidden,
        dynamicScreenSpaceError: tileset.dynamicScreenSpaceError,
        foveatedScreenSpaceError: tileset.foveatedScreenSpaceError,
        pointCloudShading: {
          attenuation: shading?.attenuation,
          geometricErrorScale: shading?.geometricErrorScale,
          eyeDomeLighting: shading?.eyeDomeLighting,
          eyeDomeLightingStrength: shading?.eyeDomeLightingStrength,
          eyeDomeLightingRadius: shading?.eyeDomeLightingRadius,
          maximumAttenuation: shading?.maximumAttenuation,
          baseResolution: shading?.baseResolution,
        },
        stylePointSizeExpression: tileset.style?.pointSize?.expression,
      };
    }, sourceUrl);
  }

  async function measureEptiumPostRender(
    activePage,
    sourceUrl,
    targetFrameRate,
  ) {
    return activePage.evaluate(
      async ({ sourceUrl: expectedUrl, targetFrameRate: frameRate, movement }) => {
        const viewer = window.viewer;
        const tileset = Array.from(
          { length: viewer.scene.primitives.length },
          (_, index) => viewer.scene.primitives.get(index),
        ).find((primitive) => primitive?._url === expectedUrl);
        if (!tileset) throw new Error("Eptium tileset is unavailable.");
        const previousTargetFrameRate = viewer.targetFrameRate;
        const timestamps = [];
        const remove = viewer.scene.postRender.addEventListener(() => {
          timestamps.push(performance.now());
        });
        viewer.targetFrameRate = frameRate;
        try {
          const waitMilliseconds =
            movement.durationMilliseconds / movement.steps;
          for (let index = 0; index < movement.steps; index += 1) {
            switch (index % 4) {
              case 0:
                viewer.camera.moveRight(movement.moveMeters);
                break;
              case 1:
                viewer.camera.moveForward(movement.moveMeters);
                break;
              case 2:
                viewer.camera.moveLeft(movement.moveMeters);
                break;
              default:
                viewer.camera.moveBackward(movement.moveMeters);
                break;
            }
            viewer.scene.requestRender();
            await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        } finally {
          remove();
          viewer.targetFrameRate = previousTargetFrameRate;
        }
        const frameTimes = timestamps
          .slice(1)
          .map((timestamp, index) => timestamp - timestamps[index]);
        const ordered = [...frameTimes].sort((left, right) => left - right);
        const averageFrameMilliseconds =
          frameTimes.length === 0
            ? 0
            : frameTimes.reduce((total, value) => total + value, 0) /
              frameTimes.length;
        return {
          metricSource: "Cesium.Scene.postRender/performance.now",
          targetFrameRate: frameRate,
          frameCount: frameTimes.length,
          averageFramesPerSecond:
            averageFrameMilliseconds > 0
              ? 1000 / averageFrameMilliseconds
              : 0,
          averageFrameMilliseconds,
          p95FrameMilliseconds:
            ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0,
          maximumFrameMilliseconds: ordered.at(-1) ?? 0,
        };
      },
      {
        sourceUrl,
        targetFrameRate,
        movement: configuration.performanceMovement,
      },
    );
  }

  async function readBrowserGraphics(activePage, vendor) {
    return activePage.evaluate((activeVendor) => {
      const canvas =
        activeVendor === "eptium"
          ? window.viewer?.scene?.canvas
          : document.querySelector("#cesium-container canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("The active Cesium canvas is unavailable.");
      }
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!context) throw new Error("WebGL is unavailable.");
      const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
      return {
        userAgent: navigator.userAgent,
        vendor: debugInfo
          ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : context.getParameter(context.VENDOR),
        renderer: debugInfo
          ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : context.getParameter(context.RENDERER),
        version: context.getParameter(context.VERSION),
        evidenceSource: "active-Cesium-canvas",
        canvasDrawingBufferWidth: canvas.width,
        canvasDrawingBufferHeight: canvas.height,
      };
    }, vendor);
  }

  async function settlePointOffCanvas(activePage, vendor) {
    await activePage.evaluate(async (activeVendor) => {
      if (activeVendor === "eptium") {
        const viewer = window.viewer;
        await new Promise((resolve, reject) => {
          let rendered = 0;
          const timeout = setTimeout(() => {
            remove();
            reject(new Error("Timed out verifying Eptium point-off stability."));
          }, 10_000);
          const remove = viewer.scene.postRender.addEventListener(() => {
            rendered += 1;
            if (rendered >= 2) {
              clearTimeout(timeout);
              remove();
              resolve();
            } else {
              viewer.scene.requestRender();
            }
          });
          viewer.scene.requestRender();
        });
      } else {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      }
    }, vendor);
  }

  async function prepareCleanCanvasCapture(activePage, vendor) {
    return activePage.evaluate((activeVendor) => {
      const canvas =
        activeVendor === "eptium"
          ? window.viewer?.scene?.canvas
          : document.querySelector("#cesium-container canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Expected one Cesium canvas for clean capture.");
      }
      canvas.id = "external-comparison-canvas";
      const ancestors = new Set();
      let ancestor = canvas.parentElement;
      while (ancestor) {
        ancestors.add(ancestor);
        ancestor = ancestor.parentElement;
      }
      let hiddenElementCount = 0;
      for (const element of document.body.querySelectorAll("*")) {
        if (element === canvas || ancestors.has(element) || element.contains(canvas)) {
          continue;
        }
        element.style.setProperty("visibility", "hidden", "important");
        element.dataset.externalComparisonHidden = "true";
        hiddenElementCount += 1;
      }
      return readState(canvas, hiddenElementCount);

      function readState(targetCanvas, hiddenCount) {
        const canvasRect = targetCanvas.getBoundingClientRect();
        const visibleOverlays = [];
        for (const element of document.body.querySelectorAll("*")) {
          if (
            element === targetCanvas ||
            element.contains(targetCanvas) ||
            targetCanvas.contains(element)
          ) {
            continue;
          }
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const overlaps =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > canvasRect.left &&
            rect.left < canvasRect.right &&
            rect.bottom > canvasRect.top &&
            rect.top < canvasRect.bottom;
          if (
            overlaps &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) !== 0
          ) {
            visibleOverlays.push(
              element.tagName.toLowerCase() +
                (element.id ? "#" + element.id : "") +
                (element.className && typeof element.className === "string"
                  ? "." + element.className.trim().replace(/\s+/g, ".")
                  : ""),
            );
          }
        }
        return {
          cleanViewport: visibleOverlays.length === 0,
          hiddenElementCount: hiddenCount,
          visibleOverlays,
          canvasCssWidth: canvasRect.width,
          canvasCssHeight: canvasRect.height,
          canvasDrawingBufferWidth: targetCanvas.width,
          canvasDrawingBufferHeight: targetCanvas.height,
          devicePixelRatio: window.devicePixelRatio,
        };
      }
    }, vendor);
  }

  async function readCleanCanvasCaptureState(activePage) {
    return activePage.evaluate(() => {
      const canvas = document.querySelector("#external-comparison-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Clean comparison canvas is unavailable.");
      }
      const rect = canvas.getBoundingClientRect();
      const visibleOverlays = [];
      for (const element of document.body.querySelectorAll("*")) {
        if (
          element === canvas ||
          element.contains(canvas) ||
          canvas.contains(element)
        ) {
          continue;
        }
        const style = getComputedStyle(element);
        const elementRect = element.getBoundingClientRect();
        const overlaps =
          elementRect.width > 0 &&
          elementRect.height > 0 &&
          elementRect.right > rect.left &&
          elementRect.left < rect.right &&
          elementRect.bottom > rect.top &&
          elementRect.top < rect.bottom;
        if (
          overlaps &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0
        ) {
          visibleOverlays.push(element.tagName.toLowerCase());
        }
      }
      return {
        cleanViewport: visibleOverlays.length === 0,
        visibleOverlays,
        canvasCssWidth: rect.width,
        canvasCssHeight: rect.height,
        canvasDrawingBufferWidth: canvas.width,
        canvasDrawingBufferHeight: canvas.height,
        devicePixelRatio: window.devicePixelRatio,
      };
    });
  }
}
