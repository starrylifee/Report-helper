/*
 * 서명자 페이지 로직.
 * URL: sign.html?env=<envelopeId>&token=<signerToken>
 * - 봉투(PDF + 서명영역)를 불러와 읽기전용으로 렌더한다.
 * - 본인 토큰에 배정된 서명영역만 서명 가능.
 * - 서명 결과는 Firestore signatures 서브컬렉션에 기록.
 */
(function () {
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const params = new URLSearchParams(location.search);
  const envelopeId = params.get("env");
  const signerToken = params.get("token");

  const els = {
    viewer: document.getElementById("viewer"),
    docName: document.getElementById("docName"),
    signerName: document.getElementById("signerName"),
    progress: document.getElementById("signProgress"),
    empty: document.getElementById("signEmpty"),
    emptyTitle: document.getElementById("signEmptyTitle"),
    emptyMsg: document.getElementById("signEmptyMsg"),
    modal: document.getElementById("signatureModal"),
    canvas: document.getElementById("signatureCanvas"),
    closeBtn: document.getElementById("closeSignatureButton"),
    clearBtn: document.getElementById("clearSignatureButton"),
    useBtn: document.getElementById("useSignatureButton")
  };

  const state = {
    meta: null,
    pdfDoc: null,
    pageViews: new Map(),
    myFields: [],
    signatures: {},      // fieldId -> {image, signedAt}
    activeFieldId: null
  };

  const pad = {
    ctx: els.canvas.getContext("2d"),
    drawing: false,
    hasInk: false,
    prev: null
  };

  bootstrap();

  async function bootstrap() {
    if (!window.SignFlow || !window.SignFlow.available) {
      showError("연결 오류", "Firebase에 연결하지 못했어요. 잠시 후 다시 시도하세요.");
      return;
    }
    if (!envelopeId || !signerToken) {
      showError("잘못된 링크", "서명 링크가 올바르지 않습니다. 발신자에게 다시 받아주세요.");
      return;
    }

    setupSignaturePad();
    els.closeBtn.addEventListener("click", closeModal);
    els.clearBtn.addEventListener("click", clearPad);
    els.useBtn.addEventListener("click", submitSignature);
    window.addEventListener("resize", () => renderAll().catch(console.error));

    try {
      const { meta, pdfBytes } = await window.SignFlow.getEnvelope(envelopeId);
      state.meta = meta;

      const signer = (meta.signers || []).find((entry) => entry.token === signerToken);
      state.myFields = (meta.fields || []).filter((field) => field.signerToken === signerToken);

      if (state.myFields.length === 0) {
        showError("배정된 서명란 없음", "이 링크에 연결된 서명란이 없습니다. 링크를 확인해주세요.");
        return;
      }

      els.docName.textContent = meta.pdfName || "문서";
      if (signer) {
        els.signerName.textContent = `${signer.name} 님`;
        els.signerName.style.display = "";
      }

      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
      state.pdfDoc = await loadingTask.promise;

      // 서명 현황 실시간 구독
      window.SignFlow.watchSignatures(envelopeId, (map) => {
        state.signatures = map;
        updateProgress();
        repaintFields();
      });

      await renderAll();
    } catch (error) {
      console.error(error);
      showError("문서를 불러올 수 없음", "링크가 만료되었거나 문서를 찾을 수 없습니다.");
    }
  }

  async function renderAll() {
    if (!state.pdfDoc) {
      return;
    }
    els.empty.style.display = "none";
    els.viewer.innerHTML = "";
    state.pageViews.clear();

    const hostWidth = Math.max(els.viewer.clientWidth - 12, 320);
    const targetWidth = Math.min(980, hostWidth - 8);

    for (let pageNumber = 1; pageNumber <= state.pdfDoc.numPages; pageNumber += 1) {
      const page = await state.pdfDoc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = targetWidth / baseViewport.width;
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
      const ctx = canvas.getContext("2d");
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const overlay = document.createElement("div");
      overlay.className = "page-overlay";

      pageWrapper.append(canvas, overlay);
      els.viewer.appendChild(pageWrapper);

      state.pageViews.set(pageNumber, {
        overlay,
        displayWidth: viewport.width,
        displayHeight: viewport.height
      });
    }

    repaintFields();
    updateProgress();
  }

  function repaintFields() {
    state.pageViews.forEach((view) => { view.overlay.innerHTML = ""; });

    state.myFields.forEach((field) => {
      const view = state.pageViews.get(field.page);
      if (!view) {
        return;
      }
      const signed = state.signatures[field.id];

      const box = document.createElement("div");
      box.className = "annotation sigfield sign-target" + (signed ? " signed" : "");
      box.style.left = `${field.x * view.displayWidth}px`;
      box.style.top = `${field.y * view.displayHeight}px`;
      box.style.width = `${field.w * view.displayWidth}px`;
      box.style.height = `${field.h * view.displayHeight}px`;

      if (signed) {
        const img = document.createElement("img");
        img.src = signed.image;
        img.alt = "서명";
        box.appendChild(img);
        box.title = "서명 완료 — 다시 누르면 재서명";
      } else {
        box.textContent = "여기를 눌러 서명";
      }

      box.addEventListener("click", () => openModal(field.id));
      view.overlay.appendChild(box);
    });
  }

  function updateProgress() {
    const total = state.myFields.length;
    const done = state.myFields.filter((field) => state.signatures[field.id]).length;
    els.progress.textContent = `내 서명 ${done} / ${total} 완료`;
    if (total > 0 && done === total) {
      els.progress.textContent = `✅ 서명 완료 (${done}/${total})`;
    }
  }

  // ---- 서명 패드 ----
  function setupSignaturePad() {
    const canvas = els.canvas;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = "#161311";
    };
    state._resizePad = resize;

    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      pad.drawing = true;
      pad.hasInk = true;
      pad.prev = point(event);
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!pad.drawing) {
        return;
      }
      const p = point(event);
      pad.ctx.beginPath();
      pad.ctx.moveTo(pad.prev.x, pad.prev.y);
      pad.ctx.lineTo(p.x, p.y);
      pad.ctx.stroke();
      pad.prev = p;
    });
    const stop = () => { pad.drawing = false; pad.prev = null; };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointerleave", stop);
  }

  function openModal(fieldId) {
    state.activeFieldId = fieldId;
    els.modal.classList.remove("hidden");
    els.modal.removeAttribute("inert");
    els.modal.setAttribute("aria-hidden", "false");
    // 캔버스가 보인 뒤 크기 측정
    requestAnimationFrame(() => {
      if (state._resizePad) state._resizePad();
      clearPad();
    });
  }

  function closeModal() {
    els.modal.classList.add("hidden");
    els.modal.setAttribute("inert", "");
    els.modal.setAttribute("aria-hidden", "true");
    state.activeFieldId = null;
  }

  function clearPad() {
    pad.ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    pad.hasInk = false;
  }

  async function submitSignature() {
    if (!pad.hasInk) {
      els.progress.textContent = "먼저 서명을 그려주세요.";
      return;
    }
    const trimmed = trimCanvas(els.canvas);
    if (!trimmed) {
      els.progress.textContent = "서명을 인식하지 못했어요. 다시 그려주세요.";
      return;
    }
    try {
      els.useBtn.disabled = true;
      els.progress.textContent = "서명 저장 중…";
      await window.SignFlow.submitSignature(envelopeId, state.activeFieldId, {
        image: trimmed,
        signerToken: signerToken
      });
      closeModal();
      // 실시간 구독이 repaint를 처리하지만, 즉시 반영도 해준다.
      state.signatures[state.activeFieldId] = { image: trimmed };
      repaintFields();
      updateProgress();
    } catch (error) {
      console.error(error);
      els.progress.textContent = "저장 실패: " + (error && error.message ? error.message : "오류");
    } finally {
      els.useBtn.disabled = false;
    }
  }

  // 투명 배경에서 그린 영역만 잘라 PNG dataURL로 반환
  function trimCanvas(sourceCanvas) {
    const ctx = sourceCanvas.getContext("2d");
    const { width, height } = sourceCanvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 10) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) {
      return null;
    }
    const pad = 6;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width, maxX + pad);
    maxY = Math.min(height, maxY + pad);
    const out = document.createElement("canvas");
    out.width = maxX - minX;
    out.height = maxY - minY;
    out.getContext("2d").drawImage(sourceCanvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  function showError(title, message) {
    els.empty.style.display = "";
    els.emptyTitle.textContent = title;
    els.emptyMsg.textContent = message;
    els.progress.textContent = "";
  }
})();
