(function () {
  const pdfjsLib = window.pdfjsLib;
  const { PDFDocument } = window.PDFLib;
  const PRESET_DB_NAME = "fieldsign-preset-db";
  const PRESET_DB_VERSION = 2;

  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const state = {
    pdfBytes: null,
    pdfName: "",
    pdfDoc: null,
    pageMeta: [],
    pageViews: new Map(),
    pageSourceTexts: new Map(),
    annotations: [],
    textEdits: [],
    selectedId: null,
    activeTool: "select",
    pendingPlacement: null,
    renderSequence: 0,
    signatureHasInk: false,
    latestAsset: null,
    presets: {
      documents: [],
      signatures: []
    },
    sourceDocument: {
      type: null,
      name: "",
      sourceBytes: null,
      originalType: null,
      originalName: ""
    },
    modalReturnFocus: null,
    zoom: 1.0,
    mode: "pdf",  // "pdf" or "docx"
    docxHtml: null
  };

  const els = {
    pdfInput: document.getElementById("pdfInput"),
    openPdfButton: document.getElementById("openPdfButton"),
    openPdfButtonAlt: document.getElementById("openPdfButtonAlt"),
    emptyState: document.getElementById("emptyState"),
    documentMeta: document.getElementById("documentMeta"),
    statusText: document.getElementById("statusText"),
    toolHint: document.getElementById("toolHint"),
    exportButton: document.getElementById("exportButton"),
    pdfViewport: document.getElementById("pdfViewport"),
    selectionPanel: document.getElementById("selectionPanel"),
    signatureModal: document.getElementById("signatureModal"),
    openSignatureButton: document.getElementById("openSignatureButton"),
    closeSignatureButton: document.getElementById("closeSignatureButton"),
    clearSignatureButton: document.getElementById("clearSignatureButton"),
    useSignatureButton: document.getElementById("useSignatureButton"),
    signatureCanvas: document.getElementById("signatureCanvas"),
    signatureFileInput: document.getElementById("signatureFileInput"),
    photoFileInput: document.getElementById("photoFileInput"),
    viewerBadge: document.getElementById("viewerBadge"),
    saveDocumentPresetButton: document.getElementById("saveDocumentPresetButton"),
    saveAssetPresetButton: document.getElementById("saveAssetPresetButton"),
    documentPresetList: document.getElementById("documentPresetList"),
    signaturePresetList: document.getElementById("signaturePresetList"),
    // Popover elements
    editPopover: document.getElementById("editPopover"),
    popoverTextarea: document.getElementById("popoverTextarea"),
    popoverFontSize: document.getElementById("popoverFontSize"),
    popoverColor: document.getElementById("popoverColor"),
    popoverRestore: document.getElementById("popoverRestore"),
    popoverDelete: document.getElementById("popoverDelete"),
    popoverDone: document.getElementById("popoverDone"),
    annotationPopover: document.getElementById("annotationPopover"),
    annotationPopoverBody: document.getElementById("annotationPopoverBody"),
    // Zoom
    zoomInBtn: document.getElementById("zoomInBtn"),
    zoomOutBtn: document.getElementById("zoomOutBtn"),
    zoomLabel: document.getElementById("zoomLabel")
  };

  const signaturePad = {
    canvas: els.signatureCanvas,
    ctx: els.signatureCanvas.getContext("2d"),
    drawing: false,
    previousPoint: null
  };

  const toolButtons = Array.from(document.querySelectorAll("[data-tool]"));
  const presetDbPromise = openPresetDb().catch((error) => {
    console.error(error);
    return null;
  });
  let renderDebounce = null;

  bootstrap();

  function bootstrap() {
    els.openPdfButton.addEventListener("click", () => els.pdfInput.click());
    if (els.openPdfButtonAlt) {
      els.openPdfButtonAlt.addEventListener("click", () => els.pdfInput.click());
    }
    els.pdfInput.addEventListener("change", handlePdfFileInput);
    els.exportButton.addEventListener("click", exportPdf);
    els.openSignatureButton.addEventListener("click", openSignatureModal);
    els.closeSignatureButton.addEventListener("click", closeSignatureModal);
    els.clearSignatureButton.addEventListener("click", clearSignaturePad);
    els.useSignatureButton.addEventListener("click", commitSignaturePad);
    els.signatureFileInput.addEventListener("change", handleSignatureUpload);
    els.photoFileInput.addEventListener("change", handlePhotoUpload);
    els.saveDocumentPresetButton.addEventListener("click", saveCurrentDocumentPreset);
    els.saveAssetPresetButton.addEventListener("click", saveLatestAssetPreset);

    toolButtons.forEach((button) => {
      button.addEventListener("click", () => setActiveTool(button.dataset.tool));
    });

    // Popover inline edit events
    setupPopoverListeners();

    // Zoom controls
    if (els.zoomInBtn) els.zoomInBtn.addEventListener("click", () => setZoom(state.zoom + 0.25));
    if (els.zoomOutBtn) els.zoomOutBtn.addEventListener("click", () => setZoom(state.zoom - 0.25));
    setupPinchZoom();

    // Close popovers on outside click
    document.addEventListener("mousedown", (event) => {
      if (els.editPopover && !els.editPopover.classList.contains("hidden") && !els.editPopover.contains(event.target)) {
        hideEditPopover();
      }
      if (els.annotationPopover && !els.annotationPopover.classList.contains("hidden") && !els.annotationPopover.contains(event.target)) {
        hideAnnotationPopover();
      }
    });

    window.addEventListener("resize", scheduleRender);
    window.addEventListener("keydown", handleKeyDown);

    setupSignatureCanvas();
    renderPresetLists();
    updatePresetButtons();
    updateExportButtons();
    loadPresets().catch((error) => {
      console.error(error);
    });
  }

  async function handlePdfFileInput(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    try {
      const documentType = detectDocumentType(file.name);

      if (documentType === "docx") {
        const arrayBuffer = await file.arrayBuffer();
        await loadDocxFile(arrayBuffer, file.name);
        return;
      }

      if (documentType !== "pdf") {
        setStatus("PDF 또는 DOCX만 열 수 있어요.");
        return;
      }

      const arrayBuffer = await file.arrayBuffer();
      await loadPdfBytes(arrayBuffer, file.name, {
        sourceBytes: new Uint8Array(arrayBuffer)
      });
    } catch (error) {
      console.error(error);
      setStatus("파일을 읽지 못했어요. 손상된 파일일 수 있어요.");
    } finally {
      event.target.value = "";
    }
  }

  async function loadPdfBytes(bytes, fileName, options = {}) {
    setStatus("PDF 여는 중…");
    const normalizedPdfBytes = toUint8Array(bytes);
    if (!normalizedPdfBytes) {
      throw new Error("invalid pdf bytes");
    }

    const workerPdfBytes = cloneUint8Array(normalizedPdfBytes);
    const persistedPdfBytes = cloneUint8Array(normalizedPdfBytes);
    const sourceBytes = toUint8Array(options.sourceBytes);
    const persistedSourceBytes = sourceBytes
      ? cloneUint8Array(sourceBytes)
      : cloneUint8Array(normalizedPdfBytes);

    const loadingTask = pdfjsLib.getDocument({ data: workerPdfBytes });
    const pdfDoc = await loadingTask.promise;
    const baseDocumentName = (options.sourceName || fileName).replace(/\.pdf$/i, "");

    state.pdfBytes = persistedPdfBytes;
    state.pdfDoc = pdfDoc;
    state.pdfName = baseDocumentName;
    state.pageMeta = [];
    state.pageViews.clear();
    state.pageSourceTexts.clear();
    state.annotations = [];
    state.textEdits = [];
    state.selectedId = null;
    state.pendingPlacement = null;
    setActiveTool("select", false);
    state.sourceDocument = {
      type: "pdf",
      name: options.sourceName || fileName,
      sourceBytes: persistedSourceBytes,
      originalType: "pdf",
      originalName: options.originalName || options.sourceName || fileName
    };

    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      state.pageMeta.push({
        pageNumber,
        pdfWidth: viewport.width,
        pdfHeight: viewport.height
      });
      state.pageSourceTexts.set(pageNumber, extractSourceTextBlocks(textContent, viewport, pageNumber));
    }

    const sourceLabel = options.sourceName || fileName;
    els.documentMeta.textContent = `${sourceLabel} · ${pdfDoc.numPages}페이지`;
    els.exportButton.disabled = false;
    els.viewerBadge.textContent = `PDF`;
    els.viewerBadge.style.display = "";
    if (els.emptyState) els.emptyState.style.display = "none";
    state.mode = "pdf";
    updatePresetButtons();
    updateExportButtons();
    await renderDocument();
    setStatus("수정할 부분을 클릭하세요.");
  }

  function setStatus(message) {
    els.statusText.textContent = message;
  }

  function detectDocumentType(fileName) {
    const lower = String(fileName || "").toLowerCase();
    if (lower.endsWith(".pdf")) return "pdf";
    if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "docx";
    return "unknown";
  }

  function updateExportButtons() {
    const hasDoc = Boolean(state.pdfBytes) || state.mode === "docx";
    els.exportButton.disabled = !hasDoc;
    els.exportButton.textContent = "다운로드";
  }

  function updateWorkflowUi() {
    // Simplified – no workflow cards in the new UI
  }

  // ═══ Zoom ═══

  function setZoom(level) {
    state.zoom = clamp(level, 0.25, 4.0);
    if (els.zoomLabel) els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    applyZoom();
  }

  function applyZoom() {
    const wrapper = els.pdfViewport.querySelector(".zoom-wrapper");
    if (wrapper) {
      wrapper.style.transform = `scale(${state.zoom})`;
    }
    // For docx container
    const docxEl = els.pdfViewport.querySelector(".docx-container");
    if (docxEl && !wrapper) {
      docxEl.style.transform = `scale(${state.zoom})`;
      docxEl.style.transformOrigin = "top center";
    }
  }

  function setupPinchZoom() {
    let initialDistance = null;
    let initialZoom = 1;

    els.pdfViewport.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        initialDistance = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        initialZoom = state.zoom;
      }
    }, { passive: false });

    els.pdfViewport.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && initialDistance) {
        e.preventDefault();
        const currentDistance = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const scale = currentDistance / initialDistance;
        setZoom(initialZoom * scale);
      }
    }, { passive: false });

    els.pdfViewport.addEventListener("touchend", () => {
      initialDistance = null;
    });
  }

  // ═══ DOCX Loading ═══

  async function loadDocxFile(arrayBuffer, fileName) {
    if (!window.mammoth) {
      setStatus("DOCX 라이브러리를 불러오는 중이에요...");
      return;
    }

    setStatus("DOCX 여는 중…");

    try {
      const result = await mammoth.convertToHtml({ arrayBuffer }, {
        styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh"
        ]
      });

      state.mode = "docx";
      state.docxHtml = result.value;
      state.pdfBytes = null;
      state.pdfDoc = null;
      state.pageMeta = [];
      state.pageViews.clear();
      state.pageSourceTexts.clear();
      state.annotations = [];
      state.textEdits = [];
      state.selectedId = null;
      state.pendingPlacement = null;
      state.pdfName = fileName.replace(/\.(docx?|DOCX?)$/, "");

      const baseName = fileName.replace(/\.(docx?|DOCX?)$/, "");
      els.documentMeta.textContent = baseName;
      els.viewerBadge.textContent = "DOCX";
      els.viewerBadge.style.display = "";
      els.exportButton.disabled = false;
      if (els.emptyState) els.emptyState.style.display = "none";

      // Render DOCX as editable HTML
      els.pdfViewport.innerHTML = "";
      const container = document.createElement("div");
      container.className = "docx-container";
      container.contentEditable = "true";
      container.innerHTML = state.docxHtml;
      els.pdfViewport.appendChild(container);

      updateExportButtons();
      setStatus("문서를 직접 수정할 수 있어요. 서명도 추가 가능합니다.");

      if (result.messages && result.messages.length) {
        console.warn("mammoth warnings:", result.messages);
      }
    } catch (error) {
      console.error(error);
      setStatus("DOCX를 열지 못했어요.");
    }
  }

  function applyWorkflowState(element, stateLabel) {
    if (!element) {
      return;
    }
    element.dataset.state = stateLabel;
  }

  async function loadPresets() {
    const [documents, signatures] = await Promise.all([
      listPresetRecords("documentPresets"),
      listPresetRecords("signaturePresets")
    ]);

    state.presets.documents = documents.sort(sortPresetRecords);
    state.presets.signatures = signatures.sort(sortPresetRecords);
    renderPresetLists();
    updatePresetButtons();
  }

  function renderPresetLists() {
    renderDocumentPresetList();
    renderSignaturePresetList();
  }

  function renderDocumentPresetList() {
    els.documentPresetList.innerHTML = "";

    if (!state.presets.documents.length) {
      els.documentPresetList.innerHTML = '<div class="preset-empty">없음</div>';
      return;
    }

    state.presets.documents.forEach((preset) => {
      const item = document.createElement("article");
      item.className = "preset-item";

      const title = document.createElement("strong");
      title.textContent = preset.name;
      const meta = document.createElement("p");
      meta.className = "preset-meta";
      meta.textContent = `${String(preset.sourceType || "pdf").toUpperCase()} · ${preset.pageCount || "?"}페이지 · ${formatDateTime(preset.createdAt)}`;

      const buttons = document.createElement("div");
      buttons.className = "preset-buttons";

      const useButton = document.createElement("button");
      useButton.className = "ghost-btn";
      useButton.type = "button";
      useButton.textContent = "불러오기";
      useButton.addEventListener("click", () => applyDocumentPreset(preset.id));

      const deleteButton = document.createElement("button");
      deleteButton.className = "ghost-btn";
      deleteButton.type = "button";
      deleteButton.textContent = "삭제";
      deleteButton.addEventListener("click", () => removePreset("documentPresets", preset.id, "서식 프리셋"));

      buttons.append(useButton, deleteButton);
      item.append(title, meta, buttons);
      els.documentPresetList.appendChild(item);
    });
  }

  function renderSignaturePresetList() {
    els.signaturePresetList.innerHTML = "";

    if (!state.presets.signatures.length) {
      els.signaturePresetList.innerHTML = '<div class="preset-empty">없음</div>';
      return;
    }

    state.presets.signatures.forEach((preset) => {
      const item = document.createElement("article");
      item.className = "preset-item";

      const title = document.createElement("strong");
      title.textContent = preset.name;
      const meta = document.createElement("p");
      meta.className = "preset-meta";
      meta.textContent = `${preset.kind === "signature" ? "현장 서명" : "서명 이미지"} · ${formatDateTime(preset.createdAt)}`;

      const buttons = document.createElement("div");
      buttons.className = "preset-buttons";

      const useButton = document.createElement("button");
      useButton.className = "ghost-btn";
      useButton.type = "button";
      useButton.textContent = "배치 준비";
      useButton.addEventListener("click", () => applySignaturePreset(preset.id));

      const deleteButton = document.createElement("button");
      deleteButton.className = "ghost-btn";
      deleteButton.type = "button";
      deleteButton.textContent = "삭제";
      deleteButton.addEventListener("click", () => removePreset("signaturePresets", preset.id, "서명 프리셋"));

      buttons.append(useButton, deleteButton);
      item.append(title, meta, buttons);
      els.signaturePresetList.appendChild(item);
    });
  }

  function updatePresetButtons() {
    els.saveDocumentPresetButton.disabled = !state.pdfBytes;
    const signatureSource = getSignaturePresetSource();
    els.saveAssetPresetButton.disabled = !signatureSource;
  }

  async function saveCurrentDocumentPreset() {
    if (!state.pdfBytes) {
      return;
    }

    const suggestedName = sanitizePresetName(state.pdfName || `문서 ${formatTimestamp(new Date())}`);
    const inputName = window.prompt("프리셋 이름을 입력하세요.", suggestedName);
    const name = sanitizePresetName(inputName);
    if (!name) {
      return;
    }

    const record = {
      id: createId(),
      name,
      fileName: `${name}.pdf`,
      pageCount: state.pageMeta.length,
      createdAt: new Date().toISOString(),
      sourceType: "pdf",
      sourceName: state.sourceDocument.name || `${name}.pdf`,
      originalType: "pdf",
      originalName: state.sourceDocument.name || `${name}.pdf`,
      sourceBytes: state.pdfBytes.slice().buffer,
      previewBytes: state.pdfBytes.slice().buffer
    };

    try {
      await putPresetRecord("documentPresets", record);
      await loadPresets();
      setStatus("문서 프리셋을 저장했어요.");
    } catch (error) {
      console.error(error);
      setStatus("프리셋 저장에 실패했어요.");
    }
  }

  async function saveLatestAssetPreset() {
    const source = getSignaturePresetSource();
    if (!source) {
      return;
    }

    const suggestedName = sanitizePresetName(source.name || `서명 ${formatTimestamp(new Date())}`);
    const inputName = window.prompt("프리셋 이름을 입력하세요.", suggestedName);
    const name = sanitizePresetName(inputName);
    if (!name) {
      return;
    }

    const record = {
      id: createId(),
      name,
      kind: source.kind === "signature" ? "signature" : "image",
      aspectRatio: source.aspectRatio,
      src: source.src,
      createdAt: new Date().toISOString()
    };

    try {
      await putPresetRecord("signaturePresets", record);
      await loadPresets();
      setStatus("서명 프리셋을 저장했어요.");
    } catch (error) {
      console.error(error);
      setStatus("프리셋 저장에 실패했어요.");
    }
  }

  async function applyDocumentPreset(presetId) {
    const preset = state.presets.documents.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    try {
      const sourceName = preset.sourceName || preset.fileName || `${preset.name}.pdf`;
      const rawSource = preset.sourceBytes || preset.previewBytes || preset.bytes;
      const rawPreview = preset.previewBytes || preset.sourceBytes || preset.bytes;
      const sourceBytes = new Uint8Array(rawSource);
      const previewBytes = new Uint8Array(rawPreview);
      await loadPdfBytes(previewBytes, sourceName, {
        sourceType: "pdf",
        sourceName,
        sourceBytes
      });

      setStatus("프리셋을 불러왔어요.");
    } catch (error) {
      console.error(error);
      setStatus("프리셋을 불러올 수 없어요.");
    }
  }

  function applySignaturePreset(presetId) {
    const preset = state.presets.signatures.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    state.pendingPlacement = {
      kind: preset.kind,
      src: preset.src,
      aspectRatio: preset.aspectRatio
    };
    state.latestAsset = {
      kind: preset.kind,
      src: preset.src,
      aspectRatio: preset.aspectRatio,
      name: preset.name
    };
    updatePresetButtons();
    setActiveTool("select", false);
    setStatus("페이지를 클릭해서 배치하세요.");
  }

  async function removePreset(storeName, presetId, label) {
    try {
      await deletePresetRecord(storeName, presetId);
      await loadPresets();
      setStatus(`${label}을 삭제했어요.`);
    } catch (error) {
      console.error(error);
      setStatus(`${label} 삭제에 실패했어요.`);
    }
  }

  function setActiveTool(tool, updateStatus = true) {
    state.activeTool = tool;
    if (tool !== "select") {
      state.pendingPlacement = null;
    }

    toolButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });

    const labelMap = {
      select: "선택/이동",
      text: "텍스트 추가",
      mask: "가림판 추가"
    };
    if (els.toolHint) els.toolHint.textContent = `${labelMap[tool] || "선택"}`;

    if (updateStatus) {
      if (tool === "text") {
        setStatus("페이지를 클릭하면 텍스트가 추가돼요.");
      } else if (tool === "mask") {
        setStatus("가릴 부분을 클릭하세요.");
      } else if (tool === "select") {
        setStatus("수정할 부분을 클릭하세요.");
      }
    }
  }

  async function renderDocument() {
    if (!state.pdfDoc) {
      return;
    }

    const currentRender = ++state.renderSequence;
    const viewportHostWidth = Math.max(els.pdfViewport.clientWidth - 12, 320);
    const targetWidth = Math.min(980, viewportHostWidth - 8);
    els.pdfViewport.innerHTML = "";
    state.pageViews.clear();

    // Create zoom wrapper
    const zoomWrapper = document.createElement("div");
    zoomWrapper.className = "zoom-wrapper";
    zoomWrapper.style.transform = `scale(${state.zoom})`;

    for (const meta of state.pageMeta) {
      const page = await state.pdfDoc.getPage(meta.pageNumber);
      if (currentRender !== state.renderSequence) {
        return;
      }

      const scale = targetWidth / meta.pdfWidth;
      const viewport = page.getViewport({ scale });

      const pageWrapper = document.createElement("div");
      pageWrapper.className = "page-wrapper";
      pageWrapper.style.width = `${viewport.width}px`;
      pageWrapper.style.height = `${viewport.height}px`;

      const canvas = document.createElement("canvas");
      canvas.className = "page-canvas";
      canvas.width = Math.floor(viewport.width * window.devicePixelRatio);
      canvas.height = Math.floor(viewport.height * window.devicePixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const canvasContext = canvas.getContext("2d");
      canvasContext.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      await page.render({ canvasContext, viewport }).promise;

      const overlay = document.createElement("div");
      overlay.className = "page-overlay";
      overlay.dataset.page = String(meta.pageNumber);
      overlay.addEventListener("click", handleOverlayClick);

      pageWrapper.append(canvas, overlay);
      zoomWrapper.appendChild(pageWrapper);

      state.pageViews.set(meta.pageNumber, {
        pageNumber: meta.pageNumber,
        pdfWidth: meta.pdfWidth,
        pdfHeight: meta.pdfHeight,
        displayWidth: viewport.width,
        displayHeight: viewport.height,
        overlay,
        pageCard: pageWrapper
      });

      renderAnnotationsForPage(meta.pageNumber);
    }

    els.pdfViewport.appendChild(zoomWrapper);
  }

  function scheduleRender() {
    if (!state.pdfDoc) {
      return;
    }

    window.clearTimeout(renderDebounce);
    renderDebounce = window.setTimeout(() => {
      renderDocument().catch((error) => {
        console.error(error);
        setStatus("화면을 다시 그리지 못했어요.");
      });
    }, 140);
  }

  function handleOverlayClick(event) {
    const overlay = event.currentTarget;
    const pageNumber = Number(overlay.dataset.page);
    const view = state.pageViews.get(pageNumber);

    if (!view) {
      return;
    }

    const rect = overlay.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);

    if (state.activeTool === "text") {
      const annotation = createTextAnnotation(pageNumber, x, y);
      updateTextLayout(annotation);
      addAnnotation(annotation);
      setStatus("텍스트가 추가됐어요.");
      return;
    }

    if (state.activeTool === "mask") {
      addAnnotation(createMaskAnnotation(pageNumber, x, y));
      setStatus("가림판이 추가됐어요. 드래그해서 크기를 조절하세요.");
      return;
    }

    if (state.pendingPlacement) {
      addAnnotation(createImageAnnotation(pageNumber, x, y, state.pendingPlacement));
      const label = state.pendingPlacement.kind === "signature"
        ? "서명"
        : state.pendingPlacement.kind === "photo"
          ? "사진"
          : "이미지";
      state.pendingPlacement = null;
      setActiveTool("select", false);
      setStatus(`${label}을 배치했어요.`);
      return;
    }

    clearSelection();
  }

  function extractSourceTextBlocks(textContent, viewport, pageNumber) {
    const styles = textContent.styles || {};
    const rawItems = [];

    (textContent.items || []).forEach((item) => {
      const text = String(item.str || "");
      if (!text.trim()) {
        return;
      }

      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const angle = Math.atan2(tx[1], tx[0]);
      if (Math.abs(angle) > 0.15) {
        return;
      }

      const style = styles[item.fontName] || {};
      const fontHeight = Math.max(8, Math.hypot(tx[2], tx[3]) || item.height || 12);
      const ascentRatio = Number.isFinite(style.ascent)
        ? style.ascent
        : Number.isFinite(style.descent)
          ? 1 + style.descent
          : 0.82;
      const x = tx[4];
      const y = tx[5] - fontHeight * ascentRatio;
      const width = Math.max(item.width || fontHeight * Math.max(0.9, text.length * 0.42), 4);
      const height = Math.max(fontHeight * 1.16, 10);

      rawItems.push({
        pageNumber,
        text,
        x,
        y,
        width,
        height,
        fontSize: clampNumber(fontHeight * 0.92, 9, 28)
      });
    });

    rawItems.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 2) {
        return a.y - b.y;
      }
      return a.x - b.x;
    });

    const groups = [];
    rawItems.forEach((item) => {
      const previous = groups[groups.length - 1];
      if (!previous) {
        groups.push(createSourceTextGroup(item, viewport, pageNumber, 0));
        return;
      }

      const sameLine = Math.abs(item.y - previous.rawY) < Math.max(previous.rawHeight, item.height) * 0.45;
      const gap = item.x - (previous.rawX + previous.rawWidth);
      const closeEnough = gap < Math.max(previous.fontSize, item.fontSize) * 1.4;

      if (sameLine && closeEnough) {
        const needsSpace = gap > Math.max(previous.fontSize, item.fontSize) * 0.22 && !previous.text.endsWith(" ");
        previous.text += `${needsSpace ? " " : ""}${item.text}`;
        previous.rawWidth = Math.max(previous.rawWidth, item.x + item.width - previous.rawX);
        previous.rawHeight = Math.max(previous.rawHeight, item.height);
        previous.width = clamp((previous.rawWidth) / viewport.width, 0.01, 0.95);
        previous.height = clamp((Math.max(previous.rawHeight, item.height)) / viewport.height, 0.012, 0.2);
        previous.fontSize = clampNumber(Math.max(previous.fontSize, item.fontSize), 9, 28);
      } else {
        groups.push(createSourceTextGroup(item, viewport, pageNumber, groups.length));
      }
    });

    return groups;
  }

  function createSourceTextGroup(item, viewport, pageNumber, index) {
    return {
      id: `src-${pageNumber}-${index}`,
      pageNumber,
      text: item.text,
      x: clamp(item.x / viewport.width, 0, 0.98),
      y: clamp(item.y / viewport.height, 0, 0.98),
      width: clamp(item.width / viewport.width, 0.01, 0.95),
      height: clamp(item.height / viewport.height, 0.012, 0.2),
      rawX: item.x,
      rawY: item.y,
      rawWidth: item.width,
      rawHeight: item.height,
      fontSize: item.fontSize,
      color: "#1f1b17"
    };
  }

  function findSourceText(sourceTextId) {
    if (!sourceTextId) {
      return null;
    }

    for (const sourceTexts of state.pageSourceTexts.values()) {
      const found = sourceTexts.find((entry) => entry.id === sourceTextId);
      if (found) {
        return found;
      }
    }

    return null;
  }

  function findTextEdit(sourceTextId) {
    return state.textEdits.find((entry) => entry.sourceTextId === sourceTextId) || null;
  }

  function getSelectedTarget() {
    const annotation = findAnnotation(state.selectedId);
    if (annotation) {
      return {
        kind: "annotation",
        effective: annotation,
        pageNumber: annotation.pageNumber
      };
    }

    const sourceText = findSourceText(state.selectedId);
    if (!sourceText) {
      return null;
    }

    const textEdit = findTextEdit(sourceText.id);
    return {
      kind: "source-text",
      source: sourceText,
      edit: textEdit,
      effective: textEdit || sourceText,
      pageNumber: sourceText.pageNumber
    };
  }

  function getSelectedPageNumber(selectedId) {
    if (!selectedId) {
      return null;
    }

    const annotation = findAnnotation(selectedId);
    if (annotation) {
      return annotation.pageNumber;
    }

    const sourceText = findSourceText(selectedId);
    return sourceText ? sourceText.pageNumber : null;
  }

  function createTextEditFromSource(sourceText, overrides = {}) {
    const edit = {
      id: `edit-${sourceText.id}`,
      type: "source-text-edit",
      sourceTextId: sourceText.id,
      pageNumber: sourceText.pageNumber,
      x: sourceText.x,
      y: sourceText.y,
      width: sourceText.width,
      height: sourceText.height,
      fontSize: sourceText.fontSize,
      color: sourceText.color,
      text: sourceText.text,
      deleted: false,
      lines: [sourceText.text],
      ...overrides
    };

    edit.sourceTextId = sourceText.id;
    edit.pageNumber = sourceText.pageNumber;
    edit.x = sourceText.x;
    edit.y = sourceText.y;
    edit.width = sourceText.width;
    return edit;
  }

  function updateTextEditLayout(textEdit, sourceText) {
    const meta = getPageMeta(sourceText.pageNumber);
    if (!meta) {
      return;
    }

    textEdit.sourceTextId = sourceText.id;
    textEdit.pageNumber = sourceText.pageNumber;
    textEdit.x = sourceText.x;
    textEdit.y = sourceText.y;
    textEdit.width = sourceText.width;
    textEdit.fontSize = clampNumber(Number(textEdit.fontSize) || sourceText.fontSize, 9, 42);
    textEdit.color = textEdit.color || sourceText.color;
    textEdit.text = typeof textEdit.text === "string" ? textEdit.text : sourceText.text;

    if (textEdit.deleted) {
      textEdit.height = sourceText.height;
      textEdit.lines = [];
      return;
    }

    const widthOnPdf = textEdit.width * meta.pdfWidth;
    const fontSize = textEdit.fontSize;
    const lineHeight = fontSize * 1.35;
    const font = `${fontSize}px "IBM Plex Sans KR", "Inter", sans-serif`;
    const lines = wrapText(textEdit.text || " ", font, Math.max(widthOnPdf - 8, 28));
    textEdit.lines = lines;
    // Allow small expansion for padding/font differences, but prevent large overflow
    const naturalH = (lines.length * lineHeight + 4) / meta.pdfHeight;
    textEdit.height = clamp(naturalH, sourceText.height, sourceText.height * 1.25);
  }

  function upsertTextEdit(sourceTextId, patch = {}) {
    const sourceText = findSourceText(sourceTextId);
    if (!sourceText) {
      return null;
    }

    const existingIndex = state.textEdits.findIndex((entry) => entry.sourceTextId === sourceTextId);
    const current = existingIndex >= 0 ? state.textEdits[existingIndex] : createTextEditFromSource(sourceText);
    const next = createTextEditFromSource(sourceText, {
      ...current,
      ...patch
    });

    next.deleted = Boolean(patch.deleted ?? current.deleted);
    updateTextEditLayout(next, sourceText);

    if (existingIndex >= 0) {
      state.textEdits.splice(existingIndex, 1, next);
    } else {
      state.textEdits.push(next);
    }

    updateWorkflowUi();
    return next;
  }

  function removeTextEdit(sourceTextId) {
    const existingIndex = state.textEdits.findIndex((entry) => entry.sourceTextId === sourceTextId);
    if (existingIndex === -1) {
      return false;
    }

    state.textEdits.splice(existingIndex, 1);
    updateWorkflowUi();
    return true;
  }

  function addAnnotation(annotation) {
    state.annotations.push(annotation);
    state.selectedId = annotation.id;
    renderAnnotationsForPage(annotation.pageNumber);
    renderSelectionPanel();
    updatePresetButtons();
  }

  function createTextAnnotation(pageNumber, x, y) {
    const width = 0.34;
    const fontSize = 18;
    const startX = clamp(x, 0.02, 1 - width - 0.02);
    return {
      id: createId(),
      type: "text",
      pageNumber,
      x: startX,
      y: clamp(y, 0.02, 0.94),
      width,
      height: 0.06,
      fontSize,
      color: "#1f1b17",
      text: "회의록 내용을 입력하세요",
      lines: ["회의록 내용을 입력하세요"]
    };
  }

  function createMaskAnnotation(pageNumber, x, y) {
    const width = 0.24;
    const height = 0.07;
    return {
      id: createId(),
      type: "mask",
      pageNumber,
      x: clamp(x, 0.02, 1 - width - 0.02),
      y: clamp(y, 0.02, 1 - height - 0.02),
      width,
      height
    };
  }

  function createImageAnnotation(pageNumber, x, y, pending) {
    const meta = getPageMeta(pageNumber);
    const size = getDefaultImagePlacementSize(meta, pending);
    return {
      id: createId(),
      type: pending.kind,
      pageNumber,
      x: clamp(x, 0.02, 1 - size.width - 0.02),
      y: clamp(y, 0.02, 1 - size.height - 0.02),
      width: size.width,
      height: size.height,
      aspectRatio: pending.aspectRatio,
      src: pending.src
    };
  }

  function getDefaultImagePlacementSize(meta, pending) {
    const isPhoto = pending.kind === "photo";
    const maxWidthRatio = isPhoto ? 0.42 : 0.24;
    const maxHeightRatio = isPhoto ? 0.32 : 0.14;
    const minWidthRatio = isPhoto ? 0.12 : 0.08;
    let widthOnPdf = meta.pdfWidth * maxWidthRatio;
    let heightOnPdf = widthOnPdf / pending.aspectRatio;

    if (heightOnPdf > meta.pdfHeight * maxHeightRatio) {
      heightOnPdf = meta.pdfHeight * maxHeightRatio;
      widthOnPdf = heightOnPdf * pending.aspectRatio;
    }

    const width = clamp(widthOnPdf / meta.pdfWidth, minWidthRatio, maxWidthRatio);
    const height = clamp(heightOnPdf / meta.pdfHeight, 0.02, maxHeightRatio);

    return { width, height };
  }

  function renderAnnotationsForPage(pageNumber) {
    const view = state.pageViews.get(pageNumber);
    if (!view) {
      return;
    }

    view.overlay.innerHTML = "";

    const sourceTexts = state.pageSourceTexts.get(pageNumber) || [];
    sourceTexts.forEach((sourceText) => {
      const textEdit = findTextEdit(sourceText.id);
      const activeRect = textEdit || sourceText;

      if (textEdit) {
        const patchNode = document.createElement("div");
        patchNode.className = `source-text-patch ${textEdit.deleted ? "deleted" : "text"}`;
        patchNode.classList.toggle("selected", sourceText.id === state.selectedId);
        Object.assign(patchNode.style, getAnnotationStyle(activeRect, view));
        patchNode.addEventListener("click", (event) => {
          event.stopPropagation();
          selectSourceText(sourceText.id);
        });

        if (!textEdit.deleted) {
          patchNode.textContent = textEdit.text;
          patchNode.style.fontSize = `${pointsToDisplayPixels(textEdit.fontSize, view)}px`;
          patchNode.style.color = textEdit.color;
        }

        view.overlay.appendChild(patchNode);
      }

      const hitbox = document.createElement("div");
      hitbox.className = "source-text-hitbox";
      hitbox.classList.toggle("selected", sourceText.id === state.selectedId);
      Object.assign(hitbox.style, getAnnotationStyle(activeRect, view));
      hitbox.title = sourceText.text;
      hitbox.addEventListener("click", (event) => {
        event.stopPropagation();
        selectSourceText(sourceText.id);
      });
      view.overlay.appendChild(hitbox);
    });

    const annotations = state.annotations.filter((annotation) => annotation.pageNumber === pageNumber);
    annotations.forEach((annotation) => {
      if (annotation.type === "text") {
        updateTextLayout(annotation);
      }

      const node = document.createElement("div");
      node.className = `annotation ${annotation.type === "mask" ? "mask" : annotation.type === "text" ? "text" : "image"}`;
      node.classList.toggle("selected", annotation.id === state.selectedId);
      node.dataset.annotationId = annotation.id;

      const style = getAnnotationStyle(annotation, view);
      Object.assign(node.style, style);
      node.addEventListener("pointerdown", (event) => handleAnnotationPointerDown(event, annotation.id, "drag"));
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        selectAnnotation(annotation.id);
      });

      if (annotation.type === "text") {
        node.textContent = annotation.text;
        node.style.fontSize = `${pointsToDisplayPixels(annotation.fontSize, view)}px`;
        node.style.color = annotation.color;
      } else if (isVisualAnnotation(annotation)) {
        const image = document.createElement("img");
        image.src = annotation.src;
        image.alt = annotation.type === "signature" ? "서명" : annotation.type === "photo" ? "사진" : "첨부 이미지";
        node.appendChild(image);
      }

      const handle = document.createElement("div");
      handle.className = "resize-handle";
      handle.addEventListener("pointerdown", (event) => handleAnnotationPointerDown(event, annotation.id, "resize"));
      node.appendChild(handle);
      view.overlay.appendChild(node);
    });
  }

  function getAnnotationStyle(annotation, view) {
    return {
      left: `${annotation.x * view.displayWidth}px`,
      top: `${annotation.y * view.displayHeight}px`,
      width: `${annotation.width * view.displayWidth}px`,
      height: `${annotation.height * view.displayHeight}px`
    };
  }

  function handleAnnotationPointerDown(event, annotationId, mode) {
    event.preventDefault();
    event.stopPropagation();

    const annotation = findAnnotation(annotationId);
    if (!annotation) {
      return;
    }

    selectAnnotation(annotationId);

    const pageView = state.pageViews.get(annotation.pageNumber);
    if (!pageView) {
      return;
    }

    const start = {
      x: event.clientX,
      y: event.clientY,
      annotationX: annotation.x,
      annotationY: annotation.y,
      annotationWidth: annotation.width,
      annotationHeight: annotation.height
    };

    const pointerId = event.pointerId;
    const minWidth = annotation.type === "mask" ? 0.03 : 0.02;
    const minHeight = annotation.type === "mask" ? 0.02 : 0.01;

    if (event.currentTarget && typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch (error) {
        // Window-level listeners already keep drag/resize alive.
      }
    }

    const onPointerMove = (moveEvent) => {
      const dx = (moveEvent.clientX - start.x) / pageView.displayWidth;
      const dy = (moveEvent.clientY - start.y) / pageView.displayHeight;

      if (mode === "drag") {
        annotation.x = clamp(start.annotationX + dx, 0, 1 - annotation.width);
        annotation.y = clamp(start.annotationY + dy, 0, 1 - annotation.height);
      } else if (annotation.type === "mask") {
        annotation.width = clamp(start.annotationWidth + dx, minWidth, 1 - annotation.x);
        annotation.height = clamp(start.annotationHeight + dy, minHeight, 1 - annotation.y);
      } else if (annotation.type === "text") {
        annotation.width = clamp(start.annotationWidth + dx, minWidth, 1 - annotation.x);
        updateTextLayout(annotation);
      } else {
        annotation.width = clamp(start.annotationWidth + dx, minWidth, 1 - annotation.x);
        const widthOnPdf = annotation.width * pageView.pdfWidth;
        annotation.height = clamp((widthOnPdf / annotation.aspectRatio) / pageView.pdfHeight, 0.01, 1 - annotation.y);
      }

      renderAnnotationsForPage(annotation.pageNumber);
      renderSelectionPanel();
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      // silent – no status update for drag/resize
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function selectSourceText(sourceTextId) {
    setSelectedEntity(sourceTextId);
  }

  function selectAnnotation(annotationId) {
    setSelectedEntity(annotationId);
  }

  function clearSelection() {
    const previousPageNumber = getSelectedPageNumber(state.selectedId);
    state.selectedId = null;
    if (previousPageNumber) {
      renderAnnotationsForPage(previousPageNumber);
    }
    renderSelectionPanel();
    hideEditPopover();
    hideAnnotationPopover();
    updatePresetButtons();
  }

  function setSelectedEntity(entityId) {
    if (state.selectedId === entityId) {
      return;
    }

    const previousPageNumber = getSelectedPageNumber(state.selectedId);
    state.selectedId = entityId;
    const nextPageNumber = getSelectedPageNumber(entityId);

    if (previousPageNumber) {
      renderAnnotationsForPage(previousPageNumber);
    }
    if (nextPageNumber && nextPageNumber !== previousPageNumber) {
      renderAnnotationsForPage(nextPageNumber);
    } else if (nextPageNumber) {
      renderAnnotationsForPage(nextPageNumber);
    }

    renderSelectionPanel();
    showPopoverForSelection();
    updatePresetButtons();
  }

  function renderSelectionPanel() {
    const selected = getSelectedTarget();

    if (!selected) {
      els.selectionPanel.className = "selection-panel empty";
      els.selectionPanel.textContent = "";
      return;
    }

    els.selectionPanel.className = "selection-panel";
    els.selectionPanel.innerHTML = "";

    const header = document.createElement("div");
    header.className = "property-group";
    const title = document.createElement("strong");
    title.textContent = getSelectionTitle(selected);
    header.appendChild(title);
    els.selectionPanel.appendChild(header);

    if (selected.kind === "source-text") {
      const sourceText = selected.source;
      const effective = selected.edit || sourceText;

      const sourceGroup = document.createElement("div");
      sourceGroup.className = "property-group";
      const sourceLabel = document.createElement("label");
      sourceLabel.textContent = "추출된 원문";
      const sourcePreview = document.createElement("div");
      sourcePreview.className = "source-text-preview";
      sourcePreview.textContent = sourceText.text;
      sourceGroup.append(sourceLabel, sourcePreview);
      els.selectionPanel.appendChild(sourceGroup);

      const textGroup = document.createElement("div");
      textGroup.className = "property-group";
      const textLabel = document.createElement("label");
      textLabel.textContent = "수정본";
      const textarea = document.createElement("textarea");
      textarea.value = effective.text;
      textGroup.append(textLabel, textarea);
      els.selectionPanel.appendChild(textGroup);

      const inline = document.createElement("div");
      inline.className = "property-inline";

      const fontWrap = document.createElement("div");
      fontWrap.className = "property-group";
      const fontLabel = document.createElement("label");
      fontLabel.textContent = "글자 크기";
      const fontInput = document.createElement("input");
      fontInput.type = "number";
      fontInput.min = "9";
      fontInput.max = "42";
      fontInput.value = String(Math.round(effective.fontSize));
      fontWrap.append(fontLabel, fontInput);

      const colorWrap = document.createElement("div");
      colorWrap.className = "property-group";
      const colorLabel = document.createElement("label");
      colorLabel.textContent = "글자 색상";
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = effective.color;
      colorWrap.append(colorLabel, colorInput);

      inline.append(fontWrap, colorWrap);
      els.selectionPanel.appendChild(inline);

      const info = document.createElement("p");
      info.className = "hint";
      info.textContent = "";
      els.selectionPanel.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "property-actions";

      const restoreButton = document.createElement("button");
      restoreButton.className = "ghost-btn";
      restoreButton.type = "button";
      restoreButton.textContent = "원문으로 되돌리기";

      const deleteButton = document.createElement("button");
      deleteButton.className = "danger-btn";
      deleteButton.type = "button";

      const syncButtons = () => {
        const currentEdit = findTextEdit(sourceText.id);
        restoreButton.disabled = !currentEdit;
        deleteButton.textContent = currentEdit && currentEdit.deleted ? "삭제 취소" : "이 구간 삭제";
      };

      const applySourceEdit = (overrides = {}) => {
        upsertTextEdit(sourceText.id, {
          text: textarea.value || " ",
          fontSize: clampNumber(Number(fontInput.value) || effective.fontSize, 9, 42),
          color: colorInput.value || effective.color,
          deleted: false,
          ...overrides
        });
        renderAnnotationsForPage(sourceText.pageNumber);
        syncButtons();
      };

      textarea.addEventListener("input", () => applySourceEdit());
      fontInput.addEventListener("input", () => applySourceEdit());
      colorInput.addEventListener("input", () => applySourceEdit());

      restoreButton.addEventListener("click", () => {
        if (!removeTextEdit(sourceText.id)) {
          return;
        }

        renderAnnotationsForPage(sourceText.pageNumber);
        renderSelectionPanel();
        setStatus("원문으로 복원했어요.");
      });

      deleteButton.addEventListener("click", () => {
        const currentEdit = findTextEdit(sourceText.id);
        const nextDeleted = !(currentEdit && currentEdit.deleted);
        applySourceEdit({ deleted: nextDeleted });
        renderSelectionPanel();
        setStatus(nextDeleted ? "삭제했어요." : "삭제를 취소했어요.");
      });

      syncButtons();
      actions.append(restoreButton, deleteButton);
      els.selectionPanel.appendChild(actions);
      return;
    }

    const annotation = selected.effective;

    if (annotation.type === "text") {
      const textGroup = document.createElement("div");
      textGroup.className = "property-group";
      const textLabel = document.createElement("label");
      textLabel.textContent = "문구";
      const textarea = document.createElement("textarea");
      textarea.value = annotation.text;
      textarea.addEventListener("input", () => {
        annotation.text = textarea.value || " ";
        updateTextLayout(annotation);
        renderAnnotationsForPage(annotation.pageNumber);
      });
      textGroup.append(textLabel, textarea);
      els.selectionPanel.appendChild(textGroup);

      const inline = document.createElement("div");
      inline.className = "property-inline";

      const fontWrap = document.createElement("div");
      fontWrap.className = "property-group";
      const fontLabel = document.createElement("label");
      fontLabel.textContent = "글자 크기";
      const fontInput = document.createElement("input");
      fontInput.type = "number";
      fontInput.min = "10";
      fontInput.max = "42";
      fontInput.value = String(annotation.fontSize);
      fontInput.addEventListener("input", () => {
        annotation.fontSize = clampNumber(Number(fontInput.value) || 18, 10, 42);
        updateTextLayout(annotation);
        renderAnnotationsForPage(annotation.pageNumber);
      });
      fontWrap.append(fontLabel, fontInput);

      const colorWrap = document.createElement("div");
      colorWrap.className = "property-group";
      const colorLabel = document.createElement("label");
      colorLabel.textContent = "글자 색상";
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = annotation.color;
      colorInput.addEventListener("input", () => {
        annotation.color = colorInput.value;
        renderAnnotationsForPage(annotation.pageNumber);
      });
      colorWrap.append(colorLabel, colorInput);

      inline.append(fontWrap, colorWrap);
      els.selectionPanel.appendChild(inline);
    }

    if (annotation.type === "mask") {
      const info = document.createElement("p");
      info.className = "hint";
      info.textContent = "";
      els.selectionPanel.appendChild(info);
    }

    if (isVisualAnnotation(annotation)) {
      const info = document.createElement("p");
      info.className = "hint";
      info.textContent = "";
      els.selectionPanel.appendChild(info);
    }

    const actions = document.createElement("div");
    actions.className = "property-actions";
    const removeButton = document.createElement("button");
    removeButton.className = "danger-btn";
    removeButton.type = "button";
    removeButton.textContent = "선택 항목 삭제";
    removeButton.addEventListener("click", () => deleteAnnotation(annotation.id));
    actions.appendChild(removeButton);
    els.selectionPanel.appendChild(actions);
  }

  function getSelectionTitle(selection) {
    const target = selection && selection.kind
      ? selection
      : selection
        ? { kind: "annotation", effective: selection, pageNumber: selection.pageNumber }
        : null;

    if (!target) {
      return "";
    }

    if (target.kind === "source-text") {
      return `원문 텍스트 · ${target.pageNumber}페이지`;
    }

    const annotation = target.effective;
    if (annotation.type === "text") {
      return `텍스트 · ${annotation.pageNumber}페이지`;
    }
    if (annotation.type === "mask") {
      return `가림판 · ${annotation.pageNumber}페이지`;
    }
    if (annotation.type === "signature") {
      return `현장 서명 · ${annotation.pageNumber}페이지`;
    }
    if (annotation.type === "photo") {
      return `사진 · ${annotation.pageNumber}페이지`;
    }
    return `서명 이미지 · ${annotation.pageNumber}페이지`;
  }

  function deleteAnnotation(annotationId) {
    const annotation = findAnnotation(annotationId);
    if (!annotation) {
      return;
    }

    state.annotations = state.annotations.filter((entry) => entry.id !== annotationId);
    state.selectedId = null;
    renderAnnotationsForPage(annotation.pageNumber);
    renderSelectionPanel();
    updatePresetButtons();
    hideAnnotationPopover();
    setStatus("삭제했어요.");
  }

  function deleteSelectedEntity(entityId) {
    const annotation = findAnnotation(entityId);
    if (annotation) {
      deleteAnnotation(entityId);
      return;
    }

    const sourceText = findSourceText(entityId);
    if (!sourceText) {
      return;
    }

    const currentEdit = findTextEdit(sourceText.id);
    const nextDeleted = !(currentEdit && currentEdit.deleted);
    upsertTextEdit(sourceText.id, {
      deleted: nextDeleted
    });
    renderAnnotationsForPage(sourceText.pageNumber);
    renderSelectionPanel();
    setStatus(nextDeleted ? "삭제했어요." : "삭제를 취소했어요.");
  }

  function updateTextLayout(annotation) {
    const meta = getPageMeta(annotation.pageNumber);
    if (!meta) {
      return;
    }

    const widthOnPdf = annotation.width * meta.pdfWidth;
    const fontSize = annotation.fontSize;
    const lineHeight = fontSize * 1.35;
    const font = `${fontSize}px \"IBM Plex Sans KR\"`;
    const lines = wrapText(annotation.text || " ", font, Math.max(widthOnPdf - 8, 40));
    annotation.lines = lines;
    annotation.height = clamp((lines.length * lineHeight + 8) / meta.pdfHeight, 0.03, 0.92);
    annotation.y = clamp(annotation.y, 0, 1 - annotation.height);
  }

  function wrapText(text, font, maxWidth) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = font;

    const rawLines = (text || " ").replace(/\r/g, "").split("\n");
    const wrapped = [];

    rawLines.forEach((rawLine) => {
      if (!rawLine) {
        wrapped.push(" ");
        return;
      }

      let currentLine = "";
      const units = Array.from(rawLine);
      units.forEach((char) => {
        const candidate = currentLine + char;
        if (ctx.measureText(candidate).width <= maxWidth || currentLine.length === 0) {
          currentLine = candidate;
        } else {
          wrapped.push(currentLine);
          currentLine = char;
        }
      });

      if (currentLine) {
        wrapped.push(currentLine);
      }
    });

    return wrapped.length ? wrapped : [" "];
  }

  function pointsToDisplayPixels(points, view) {
    return points * (view.displayWidth / view.pdfWidth);
  }

  function handleKeyDown(event) {
    if (event.key === "Delete" || event.key === "Backspace") {
      const activeElement = document.activeElement;
      const editing = activeElement && (activeElement.tagName === "TEXTAREA" || activeElement.tagName === "INPUT");
      if (!editing && state.selectedId) {
        event.preventDefault();
        deleteSelectedEntity(state.selectedId);
      }
    }

    if (event.key === "Escape") {
      if (!els.editPopover.classList.contains("hidden")) {
        hideEditPopover();
        return;
      }
      if (!els.annotationPopover.classList.contains("hidden")) {
        hideAnnotationPopover();
        return;
      }
      if (!els.signatureModal.classList.contains("hidden")) {
        closeSignatureModal();
        return;
      }

      state.pendingPlacement = null;
      setActiveTool("select");
    }
  }

  function setupSignatureCanvas() {
    resizeSignatureCanvas();
    window.addEventListener("resize", resizeSignatureCanvas);

    signaturePad.canvas.addEventListener("pointerdown", (event) => {
      signaturePad.drawing = true;
      const point = getCanvasPoint(event, signaturePad.canvas);
      signaturePad.previousPoint = point;
      signaturePad.lastTime = Date.now();
      signaturePad.ctx.lineCap = "round";
      signaturePad.ctx.lineJoin = "round";
      signaturePad.ctx.strokeStyle = "#191511";
      signaturePad.ctx.fillStyle = "#191511";
      // Initial dot with slight random size
      const dotSize = 1.0 + Math.random() * 0.6;
      signaturePad.ctx.beginPath();
      signaturePad.ctx.arc(point.x, point.y, dotSize, 0, Math.PI * 2);
      signaturePad.ctx.fill();
      signaturePad.ctx.lineWidth = 1.6 + Math.random() * 0.8;
      state.signatureHasInk = true;
    });

    signaturePad.canvas.addEventListener("pointermove", (event) => {
      if (!signaturePad.drawing) {
        return;
      }

      const point = getCanvasPoint(event, signaturePad.canvas);
      const prev = signaturePad.previousPoint;
      const now = Date.now();
      const dt = Math.max(now - (signaturePad.lastTime || now), 1);
      const dist = Math.hypot(point.x - prev.x, point.y - prev.y);
      const speed = dist / dt;

      // Speed-based width: fast = thin, slow = thick
      const targetWidth = clamp(3.2 - speed * 4, 0.8, 3.6);
      // Smooth transition
      const currentWidth = signaturePad.ctx.lineWidth;
      signaturePad.ctx.lineWidth = currentWidth * 0.6 + targetWidth * 0.4;

      signaturePad.ctx.beginPath();
      signaturePad.ctx.moveTo(prev.x, prev.y);
      signaturePad.ctx.lineTo(point.x, point.y);
      signaturePad.ctx.stroke();
      signaturePad.previousPoint = point;
      signaturePad.lastTime = now;
      state.signatureHasInk = true;
    });

    const endStroke = () => {
      signaturePad.drawing = false;
      signaturePad.previousPoint = null;
      signaturePad.lastTime = null;
    };

    signaturePad.canvas.addEventListener("pointerup", endStroke);
    signaturePad.canvas.addEventListener("pointerleave", endStroke);
    signaturePad.canvas.addEventListener("pointercancel", endStroke);
  }

  function resizeSignatureCanvas() {
    const rect = signaturePad.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    signaturePad.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    signaturePad.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    signaturePad.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    signaturePad.ctx.clearRect(0, 0, rect.width, rect.height);
    state.signatureHasInk = false;
  }

  function clearSignaturePad() {
    const rect = signaturePad.canvas.getBoundingClientRect();
    signaturePad.ctx.clearRect(0, 0, rect.width, rect.height);
    state.signatureHasInk = false;
  }

  function openSignatureModal() {
    state.modalReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : els.openSignatureButton;
    els.signatureModal.classList.remove("hidden");
    els.signatureModal.removeAttribute("inert");
    els.signatureModal.setAttribute("aria-hidden", "false");
    resizeSignatureCanvas();
    window.requestAnimationFrame(() => {
      els.useSignatureButton.focus();
    });
    setStatus("서명하고 '사용하기'를 누르세요.");
  }

  function closeSignatureModal() {
    const returnFocusTarget = state.modalReturnFocus || els.openSignatureButton;
    if (document.activeElement instanceof HTMLElement && els.signatureModal.contains(document.activeElement)) {
      returnFocusTarget.focus();
    }
    els.signatureModal.classList.add("hidden");
    els.signatureModal.setAttribute("inert", "");
    els.signatureModal.setAttribute("aria-hidden", "true");
    state.modalReturnFocus = null;
  }

  function commitSignaturePad() {
    if (!state.signatureHasInk) {
      setStatus("서명을 먼저 그려주세요.");
      return;
    }

    const trimmed = trimCanvas(signaturePad.canvas);
    if (!trimmed) {
      setStatus("서명을 인식하지 못했어요. 다시 그려주세요.");
      return;
    }

    state.pendingPlacement = {
      kind: "signature",
      src: trimmed.dataUrl,
      aspectRatio: trimmed.width / trimmed.height
    };
    state.latestAsset = {
      kind: "signature",
      src: trimmed.dataUrl,
      aspectRatio: trimmed.width / trimmed.height,
      name: `현장 서명 ${formatTimestamp(new Date())}`
    };
    setActiveTool("select", false);
    updatePresetButtons();
    closeSignatureModal();
    setStatus("페이지를 클릭해서 서명을 배치하세요.");
  }

  async function handleSignatureUpload(event) {
    await handleAssetUpload(event, "image");
  }

  async function handlePhotoUpload(event) {
    await handleAssetUpload(event, "photo");
  }

  async function handleAssetUpload(event, kind) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    try {
      const initialSrc = await fileToDataUrl(file);
      const normalized = await normalizeImageSource(initialSrc, { removeBackground: kind !== "photo" });
      state.pendingPlacement = {
        kind,
        src: normalized.src,
        aspectRatio: normalized.width / normalized.height
      };
      state.latestAsset = {
        kind,
        src: normalized.src,
        aspectRatio: normalized.width / normalized.height,
        name: file.name.replace(/\.[^.]+$/i, "")
      };
      updatePresetButtons();
      setStatus("페이지를 클릭해서 배치하세요.");
      setActiveTool("select", false);
    } catch (error) {
      console.error(error);
      setStatus("이미지를 읽지 못했어요.");
    } finally {
      event.target.value = "";
    }
  }

  async function exportPdf() {
    if (state.mode === "docx") {
      setStatus("인쇄 대화상자로 PDF를 저장하세요.");
      window.print();
      return;
    }

    if (!state.pdfBytes) {
      setStatus("저장할 PDF가 없어요.");
      return;
    }

    try {
      setStatus("PDF 저장 중…");
      const pdfBytes = await composePdfBytes();
      downloadBlob(new Blob([pdfBytes], { type: "application/pdf" }), `${state.pdfName || "signed-document"}-signed.pdf`);
      setStatus("다운로드 완료!");
    } catch (error) {
      console.error(error);
      setStatus(isPdfExportError(error)
        ? "PDF를 다시 열고 저장해주세요."
        : "저장 중 오류가 발생했어요.");
    }
  }

  async function composePdfBytes() {
    await document.fonts.ready;
    const composablePdfBytes = await getComposablePdfBytes();
    const pdfDoc = await PDFDocument.load(composablePdfBytes);
    const imageCache = new Map();

    for (const textEdit of state.textEdits) {
      const sourceText = findSourceText(textEdit.sourceTextId);
      if (!sourceText) {
        continue;
      }

      const page = pdfDoc.getPage(sourceText.pageNumber - 1);
      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();
      const x = textEdit.x * pageWidth;
      const y = pageHeight - (textEdit.y + textEdit.height) * pageHeight;
      const width = textEdit.width * pageWidth;
      const height = textEdit.height * pageHeight;
      const paddingX = Math.min(6, pageWidth * 0.006);
      const paddingY = Math.min(4, pageHeight * 0.004);
      const rectX = Math.max(0, x - paddingX);
      const rectY = Math.max(0, y - paddingY);

      page.drawRectangle({
        x: rectX,
        y: rectY,
        width: Math.min(pageWidth - rectX, width + paddingX * 2),
        height: Math.min(pageHeight - rectY, height + paddingY * 2),
        color: window.PDFLib.rgb(1, 1, 1)
      });

      if (textEdit.deleted) {
        continue;
      }

      const source = renderTextAnnotationImage(textEdit, pageWidth, pageHeight);
      let embedded = imageCache.get(source);
      if (!embedded) {
        embedded = await pdfDoc.embedPng(dataUrlToUint8Array(source));
        imageCache.set(source, embedded);
      }

      page.drawImage(embedded, { x, y, width, height });
    }

    for (const annotation of state.annotations) {
      const page = pdfDoc.getPage(annotation.pageNumber - 1);
      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();
      const x = annotation.x * pageWidth;
      const y = pageHeight - (annotation.y + annotation.height) * pageHeight;
      const width = annotation.width * pageWidth;
      const height = annotation.height * pageHeight;

      if (annotation.type === "mask") {
        page.drawRectangle({
          x,
          y,
          width,
          height,
          color: window.PDFLib.rgb(1, 1, 1)
        });
        continue;
      }

      let source = annotation.src;
      if (annotation.type === "text") {
        source = renderTextAnnotationImage(annotation, pageWidth, pageHeight);
      }

      let embedded = imageCache.get(source);
      if (!embedded) {
        const bytes = dataUrlToUint8Array(source);
        embedded = source.startsWith("data:image/jpeg")
          ? await pdfDoc.embedJpg(bytes)
          : await pdfDoc.embedPng(bytes);
        imageCache.set(source, embedded);
      }

      page.drawImage(embedded, { x, y, width, height });
    }

    return pdfDoc.save();
  }

  function serializeAnnotations() {
    return state.annotations.map((annotation) => ({
      id: annotation.id,
      type: annotation.type,
      pageNumber: annotation.pageNumber,
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: annotation.height,
      text: annotation.text || "",
      fontSize: annotation.fontSize || null,
      color: annotation.color || null,
      aspectRatio: annotation.aspectRatio || null,
      src: annotation.src || null
    }));
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function renderTextAnnotationImage(annotation, pageWidth, pageHeight) {
    const widthPx = Math.max(Math.round(annotation.width * pageWidth * 3), 120);
    const heightPx = Math.max(Math.round(annotation.height * pageHeight * 3), 60);
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d");
    const fontSize = annotation.fontSize * 3;
    ctx.clearRect(0, 0, widthPx, heightPx);
    ctx.font = `${fontSize}px \"IBM Plex Sans KR\"`;
    ctx.fillStyle = annotation.color;
    ctx.textBaseline = "top";

    const padding = 8 * 3;
    const lines = wrapText(annotation.text || " ", ctx.font, widthPx - padding * 2);
    lines.forEach((line, index) => {
      ctx.fillText(line, padding, padding + index * fontSize * 1.35);
    });

    return canvas.toDataURL("image/png");
  }

  function trimCanvas(sourceCanvas) {
    const ratio = window.devicePixelRatio || 1;
    const sourceWidth = sourceCanvas.width;
    const sourceHeight = sourceCanvas.height;
    const sourceCtx = sourceCanvas.getContext("2d");
    const imageData = sourceCtx.getImageData(0, 0, sourceWidth, sourceHeight).data;
    let minX = sourceWidth;
    let minY = sourceHeight;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const alpha = imageData[(y * sourceWidth + x) * 4 + 3];
        if (alpha > 0) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    if (minX > maxX || minY > maxY) {
      return null;
    }

    const padding = Math.round(18 * ratio);
    const width = maxX - minX + 1 + padding * 2;
    const height = maxY - minY + 1 + padding * 2;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(
      sourceCanvas,
      minX,
      minY,
      maxX - minX + 1,
      maxY - minY + 1,
      padding,
      padding,
      maxX - minX + 1,
      maxY - minY + 1
    );

    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: Math.round(width / ratio),
      height: Math.round(height / ratio)
    };
  }

  function getCanvasPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function getPageMeta(pageNumber) {
    return state.pageMeta.find((entry) => entry.pageNumber === pageNumber);
  }

  function findAnnotation(annotationId) {
    return state.annotations.find((annotation) => annotation.id === annotationId) || null;
  }

  function getSignaturePresetSource() {
    const selected = findAnnotation(state.selectedId);
    if (selected && (selected.type === "signature" || selected.type === "image")) {
      return {
        kind: selected.type,
        src: selected.src,
        aspectRatio: selected.aspectRatio,
        name: getSelectionTitle(selected)
      };
    }

    if (state.latestAsset && (state.latestAsset.kind === "signature" || state.latestAsset.kind === "image")) {
      return state.latestAsset;
    }

    return null;
  }

  function isVisualAnnotation(annotation) {
    return annotation.type === "signature" || annotation.type === "image" || annotation.type === "photo";
  }

  function createId() {
    return `ann-${Math.random().toString(36).slice(2, 10)}`;
  }

  function sortPresetRecords(a, b) {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }

  function sanitizePresetName(value) {
    if (!value) {
      return "";
    }

    return String(value)
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
      .slice(0, 60);
  }

  function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}${month}${day}-${hours}${minutes}`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "날짜 없음";
    }

    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function normalizeImageSource(src, options = {}) {
    const image = await loadImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    if (options.removeBackground) {
      removeNearWhiteBackground(ctx, canvas.width, canvas.height);
    }
    return {
      src: canvas.toDataURL("image/png"),
      width: image.naturalWidth,
      height: image.naturalHeight
    };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function removeNearWhiteBackground(ctx, width, height) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const alpha = data[index + 3];

      if (alpha === 0) {
        continue;
      }

      const brightest = Math.max(r, g, b);
      const darkest = Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      const isNearNeutral = brightest - darkest < 18;

      if (brightness > 247 && isNearNeutral) {
        data[index + 3] = 0;
        continue;
      }

      if (brightness > 224 && isNearNeutral) {
        data[index + 3] = Math.min(alpha, Math.max(0, Math.round((247 - brightness) * 11)));
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.split(",")[1];
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function base64ToUint8Array(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function toUint8Array(value) {
    if (!value) {
      return null;
    }

    if (value instanceof Uint8Array) {
      return value;
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    return null;
  }

  function cloneUint8Array(value) {
    const bytes = toUint8Array(value);
    if (!bytes) {
      return null;
    }

    return Uint8Array.from(bytes);
  }

  function looksLikePdfBytes(bytes) {
    return Boolean(
      bytes
      && bytes.length >= 5
      && bytes[0] === 0x25
      && bytes[1] === 0x50
      && bytes[2] === 0x44
      && bytes[3] === 0x46
      && bytes[4] === 0x2d
    );
  }

  async function getComposablePdfBytes() {
    const currentBytes = toUint8Array(state.pdfBytes);
    if (currentBytes && looksLikePdfBytes(currentBytes)) {
      return currentBytes;
    }

    if (state.pdfDoc && typeof state.pdfDoc.getData === "function") {
      const fallbackBytes = toUint8Array(await state.pdfDoc.getData());
      if (fallbackBytes && looksLikePdfBytes(fallbackBytes)) {
        state.pdfBytes = fallbackBytes.slice();
        return state.pdfBytes;
      }
    }

    throw new Error("valid pdf bytes unavailable for export");
  }

  function isPdfExportError(error) {
    const message = String(error && error.message ? error.message : "");
    return message.includes("No PDF header")
      || message.includes("valid pdf bytes unavailable");
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function openPresetDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("indexedDB is not available"));
        return;
      }

      const request = window.indexedDB.open(PRESET_DB_NAME, PRESET_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("documentPresets")) {
          db.createObjectStore("documentPresets", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("signaturePresets")) {
          db.createObjectStore("signaturePresets", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("failed to open preset db"));
    });
  }

  async function listPresetRecords(storeName) {
    const db = await presetDbPromise;
    if (!db) {
      throw new Error("preset db unavailable");
    }
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("failed to list preset records"));
    });
  }

  async function putPresetRecord(storeName, record) {
    const db = await presetDbPromise;
    if (!db) {
      throw new Error("preset db unavailable");
    }
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.put(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("failed to save preset record"));
    });
  }

  async function deletePresetRecord(storeName, presetId) {
    const db = await presetDbPromise;
    if (!db) {
      throw new Error("preset db unavailable");
    }
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.delete(presetId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error("failed to delete preset record"));
    });
  }

  // ─── Popover Inline Editing System ───

  function setupPopoverListeners() {
    // Source text edit popover
    const applyCurrentSourceEdit = () => {
      const sourceText = findSourceText(state.selectedId);
      if (!sourceText) return;
      const effective = findTextEdit(sourceText.id) || sourceText;
      upsertTextEdit(sourceText.id, {
        text: els.popoverTextarea.value || " ",
        fontSize: clampNumber(Number(els.popoverFontSize.value) || effective.fontSize, 9, 42),
        color: els.popoverColor.value || effective.color,
        deleted: false
      });
      renderAnnotationsForPage(sourceText.pageNumber);
    };

    els.popoverTextarea.addEventListener("input", applyCurrentSourceEdit);
    els.popoverFontSize.addEventListener("input", applyCurrentSourceEdit);
    els.popoverColor.addEventListener("input", applyCurrentSourceEdit);

    els.popoverRestore.addEventListener("click", () => {
      const sourceText = findSourceText(state.selectedId);
      if (!sourceText) return;
      if (removeTextEdit(sourceText.id)) {
        renderAnnotationsForPage(sourceText.pageNumber);
        setStatus("원문으로 복원했어요.");
      }
      hideEditPopover();
    });

    els.popoverDelete.addEventListener("click", () => {
      const sourceText = findSourceText(state.selectedId);
      if (!sourceText) return;
      const currentEdit = findTextEdit(sourceText.id);
      const nextDeleted = !(currentEdit && currentEdit.deleted);
      upsertTextEdit(sourceText.id, { deleted: nextDeleted });
      renderAnnotationsForPage(sourceText.pageNumber);
      setStatus(nextDeleted ? "삭제했어요." : "삭제를 취소했어요.");
      if (nextDeleted) hideEditPopover();
    });

    els.popoverDone.addEventListener("click", () => {
      hideEditPopover();
    });
  }

  function showPopoverForSelection() {
    const selected = getSelectedTarget();
    if (!selected) {
      hideEditPopover();
      hideAnnotationPopover();
      return;
    }

    if (selected.kind === "source-text") {
      showEditPopover(selected);
    } else if (selected.kind === "annotation") {
      showAnnotationPopover(selected);
    }
  }

  function showEditPopover(selected) {
    hideAnnotationPopover();
    const sourceText = selected.source;
    const effective = selected.edit || sourceText;

    els.popoverTextarea.value = effective.text;
    els.popoverFontSize.value = String(Math.round(effective.fontSize));
    els.popoverColor.value = effective.color;

    const currentEdit = findTextEdit(sourceText.id);
    els.popoverRestore.disabled = !currentEdit;
    els.popoverDelete.textContent = currentEdit && currentEdit.deleted ? "삭제 취소" : "삭제";

    els.editPopover.classList.remove("hidden");

    // Position near the selected element
    const view = state.pageViews.get(sourceText.pageNumber);
    if (view) {
      const hitbox = view.overlay.querySelector(".source-text-hitbox.selected, .source-text-patch.selected");
      if (hitbox) {
        positionPopoverNear(els.editPopover, hitbox);
        return;
      }
    }
    // Fallback: center in viewport
    els.editPopover.style.left = "50%";
    els.editPopover.style.top = "50%";
    els.editPopover.style.transform = "translate(-50%, -50%)";
  }

  function hideEditPopover() {
    if (els.editPopover) {
      els.editPopover.classList.add("hidden");
    }
  }

  function showAnnotationPopover(selected) {
    hideEditPopover();
    const annotation = selected.effective;
    const body = els.annotationPopoverBody;
    body.innerHTML = "";

    if (annotation.type === "text") {
      const textarea = document.createElement("textarea");
      textarea.value = annotation.text;
      textarea.rows = 3;
      textarea.style.cssText = "width:100%;border:1px solid rgba(0,0,0,0.12);border-radius:8px;padding:10px;font-size:13px;resize:vertical;min-height:72px;background:#f5f5f7;";
      textarea.addEventListener("input", () => {
        annotation.text = textarea.value || " ";
        updateTextLayout(annotation);
        renderAnnotationsForPage(annotation.pageNumber);
      });
      body.appendChild(textarea);

      const opts = document.createElement("div");
      opts.style.cssText = "display:flex;gap:10px;margin-top:10px;";

      const fontWrap = document.createElement("div");
      fontWrap.style.cssText = "flex:1;display:flex;flex-direction:column;gap:4px;";
      const fontLabel = document.createElement("label");
      fontLabel.textContent = "크기";
      fontLabel.style.cssText = "font-size:11px;font-weight:600;color:#6e6e73;";
      const fontInput = document.createElement("input");
      fontInput.type = "number";
      fontInput.min = "10";
      fontInput.max = "42";
      fontInput.value = String(annotation.fontSize);
      fontInput.style.cssText = "width:100%;height:32px;border:1px solid rgba(0,0,0,0.12);border-radius:8px;padding:0 8px;font-size:13px;background:#f5f5f7;";
      fontInput.addEventListener("input", () => {
        annotation.fontSize = clampNumber(Number(fontInput.value) || 18, 10, 42);
        updateTextLayout(annotation);
        renderAnnotationsForPage(annotation.pageNumber);
      });
      fontWrap.append(fontLabel, fontInput);

      const colorWrap = document.createElement("div");
      colorWrap.style.cssText = "flex:1;display:flex;flex-direction:column;gap:4px;";
      const colorLabel = document.createElement("label");
      colorLabel.textContent = "색상";
      colorLabel.style.cssText = "font-size:11px;font-weight:600;color:#6e6e73;";
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = annotation.color;
      colorInput.style.cssText = "width:100%;height:32px;border:1px solid rgba(0,0,0,0.12);border-radius:8px;padding:3px;cursor:pointer;";
      colorInput.addEventListener("input", () => {
        annotation.color = colorInput.value;
        renderAnnotationsForPage(annotation.pageNumber);
      });
      colorWrap.append(colorLabel, colorInput);

      opts.append(fontWrap, colorWrap);
      body.appendChild(opts);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;margin-top:12px;";
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "삭제";
    removeBtn.className = "pop-btn danger";
    removeBtn.style.cssText = "flex:1;height:32px;border-radius:8px;font-size:12px;font-weight:500;background:rgba(255,59,48,0.08);color:#ff3b30;border:none;cursor:pointer;";
    removeBtn.addEventListener("click", () => deleteAnnotation(annotation.id));
    const doneBtn = document.createElement("button");
    doneBtn.textContent = "완료";
    doneBtn.className = "pop-btn primary";
    doneBtn.style.cssText = "flex:1;height:32px;border-radius:8px;font-size:12px;font-weight:500;background:#6366f1;color:#fff;border:none;cursor:pointer;";
    doneBtn.addEventListener("click", () => hideAnnotationPopover());
    actions.append(removeBtn, doneBtn);
    body.appendChild(actions);

    els.annotationPopover.classList.remove("hidden");

    // Position
    const view = state.pageViews.get(annotation.pageNumber);
    if (view) {
      const node = view.overlay.querySelector(`[data-annotation-id="${annotation.id}"]`);
      if (node) {
        positionPopoverNear(els.annotationPopover, node);
        return;
      }
    }
    els.annotationPopover.style.left = "50%";
    els.annotationPopover.style.top = "50%";
    els.annotationPopover.style.transform = "translate(-50%, -50%)";
  }

  function hideAnnotationPopover() {
    if (els.annotationPopover) {
      els.annotationPopover.classList.add("hidden");
    }
  }

  function positionPopoverNear(popover, anchorElement) {
    const anchorRect = anchorElement.getBoundingClientRect();
    const popoverWidth = 300;
    const gap = 8;

    let top = anchorRect.bottom + gap;
    let left = anchorRect.left + anchorRect.width / 2 - popoverWidth / 2;

    // Keep within viewport
    if (left < 8) left = 8;
    if (left + popoverWidth > window.innerWidth - 8) {
      left = window.innerWidth - popoverWidth - 8;
    }

    // If below goes off screen, show above
    if (top + 240 > window.innerHeight) {
      top = Math.max(8, anchorRect.top - 240 - gap);
    }

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.transform = "none";
  }
})();

