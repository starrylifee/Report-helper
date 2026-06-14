/*
 * 인앱 서명 관리 화면.
 * - 메인 앱(index.html) 안에서 봉투 하나의 진행 현황을 보여준다.
 * - 수집된 서명을 드래그로 위치·크기 조절(칸과 무관하게) 후 최종 PDF로 다운로드.
 * - 조절값은 envelope이 불변이므로 localStorage에 봉투별로 저장한다.
 *
 * 노출: window.openManage(envelopeId)
 */
(function () {
  const pdfjsLib = window.pdfjsLib;
  if (pdfjsLib && pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const els = {
    overlay: document.getElementById("manageOverlay"),
    docName: document.getElementById("manageDocName"),
    progress: document.getElementById("manageProgress"),
    viewer: document.getElementById("manageViewer"),
    linksBtn: document.getElementById("manageLinksBtn"),
    downloadBtn: document.getElementById("manageDownloadBtn"),
    closeBtn: document.getElementById("manageCloseBtn")
  };

  const state = {
    envelopeId: null,
    meta: null,
    pdfBytes: null,
    pdfDoc: null,
    signatures: {},
    overrides: {},
    pageViews: new Map(),
    unsub: null
  };

  if (els.closeBtn) els.closeBtn.addEventListener("click", close);
  if (els.downloadBtn) els.downloadBtn.addEventListener("click", downloadFinalPdf);
  if (els.linksBtn) {
    els.linksBtn.addEventListener("click", () => {
      if (state.meta && typeof window.showEnvelopeLinks === "function") {
        window.showEnvelopeLinks(state.envelopeId, state.meta.signers || []);
      }
    });
  }

  window.openManage = async function (envelopeId) {
    if (!window.SignFlow || !window.SignFlow.available) {
      alert("Firebase 연결이 준비되지 않았어요.");
      return;
    }
    state.envelopeId = envelopeId;
    state.overrides = loadOverrides(envelopeId);
    els.overlay.classList.remove("hidden");
    els.overlay.setAttribute("aria-hidden", "false");
    els.viewer.innerHTML = "<p class='manage-loading'>불러오는 중…</p>";
    els.downloadBtn.disabled = true;

    try {
      const { meta, pdfBytes } = await window.SignFlow.getEnvelope(envelopeId);
      state.meta = meta;
      state.pdfBytes = pdfBytes;
      els.docName.textContent = meta.pdfName || "문서";

      state.pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;

      if (state.unsub) state.unsub();
      state.unsub = window.SignFlow.watchSignatures(envelopeId, (map) => {
        state.signatures = map;
        repaint();
        updateProgress();
      });

      await renderPages();
    } catch (error) {
      console.error(error);
      els.viewer.innerHTML = "<p class='manage-loading'>문서를 불러올 수 없습니다. 삭제되었거나 링크가 잘못되었을 수 있어요.</p>";
    }
  };

  function close() {
    if (state.unsub) {
      state.unsub();
      state.unsub = null;
    }
    els.overlay.classList.add("hidden");
    els.overlay.setAttribute("aria-hidden", "true");
    state.pdfDoc = null;
    state.pageViews.clear();
    els.viewer.innerHTML = "";
  }

  async function renderPages() {
    els.viewer.innerHTML = "";
    state.pageViews.clear();

    const hostWidth = Math.max(els.viewer.clientWidth - 40, 320);
    const targetWidth = Math.min(900, hostWidth);

    for (let pageNumber = 1; pageNumber <= state.pdfDoc.numPages; pageNumber += 1) {
      const page = await state.pdfDoc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = targetWidth / base.width;
      const viewport = page.getViewport({ scale });

      const wrapper = document.createElement("div");
      wrapper.className = "manage-page";
      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * window.devicePixelRatio);
      canvas.height = Math.floor(viewport.height * window.devicePixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const layer = document.createElement("div");
      layer.className = "manage-layer";

      wrapper.append(canvas, layer);
      els.viewer.appendChild(wrapper);

      state.pageViews.set(pageNumber, {
        layer,
        displayWidth: viewport.width,
        displayHeight: viewport.height
      });
    }

    repaint();
    updateProgress();
  }

  function currentRect(field) {
    const o = state.overrides[field.id];
    if (o) {
      return { x: o.x, y: o.y, w: o.w, h: o.h };
    }
    return { x: field.x, y: field.y, w: field.w, h: field.h };
  }

  function applyRect(box, rect, view) {
    box.style.left = `${rect.x * view.displayWidth}px`;
    box.style.top = `${rect.y * view.displayHeight}px`;
    box.style.width = `${rect.w * view.displayWidth}px`;
    box.style.height = `${rect.h * view.displayHeight}px`;
  }

  function repaint() {
    state.pageViews.forEach((view) => { view.layer.innerHTML = ""; });
    const fields = (state.meta && state.meta.fields) || [];

    fields.forEach((field) => {
      const view = state.pageViews.get(field.page);
      if (!view) {
        return;
      }
      const sig = state.signatures[field.id];
      const rect = currentRect(field);

      const box = document.createElement("div");
      box.className = "manage-sig " + (sig ? "signed" : "pending");
      applyRect(box, rect, view);

      if (sig) {
        const img = document.createElement("img");
        img.src = sig.image;
        img.alt = "서명";
        box.appendChild(img);
        box.title = `${field.assignee || ""} — 드래그로 이동, 모서리로 크기 조절`;
        box.addEventListener("pointerdown", (event) => startDrag(event, field, view, box, "move"));

        const handle = document.createElement("div");
        handle.className = "resize-handle";
        handle.addEventListener("pointerdown", (event) => startDrag(event, field, view, box, "resize"));
        box.appendChild(handle);
      } else {
        box.textContent = `${field.assignee || "담당자"} 대기`;
      }

      view.layer.appendChild(box);
    });
  }

  function startDrag(event, field, view, box, mode) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startRect = currentRect(field);
    box.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const ndx = (moveEvent.clientX - startX) / view.displayWidth;
      const ndy = (moveEvent.clientY - startY) / view.displayHeight;
      let rect;
      if (mode === "resize") {
        const w = clamp(startRect.w + ndx, 0.03, 1 - startRect.x);
        const h = clamp(startRect.h + ndy, 0.02, 1 - startRect.y);
        rect = { x: startRect.x, y: startRect.y, w, h };
      } else {
        const x = clamp(startRect.x + ndx, 0, 1 - startRect.w);
        const y = clamp(startRect.y + ndy, 0, 1 - startRect.h);
        rect = { x, y, w: startRect.w, h: startRect.h };
      }
      state.overrides[field.id] = rect;
      applyRect(box, rect, view);
    };

    const onUp = () => {
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      saveOverrides(state.envelopeId, state.overrides);
    };

    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
  }

  function updateProgress() {
    const fields = (state.meta && state.meta.fields) || [];
    const done = fields.filter((field) => state.signatures[field.id]).length;
    els.progress.textContent = `${done} / ${fields.length} 서명 완료`;
    els.downloadBtn.disabled = done === 0;
    els.downloadBtn.textContent = done === fields.length
      ? "최종 PDF 다운로드"
      : `현재까지 PDF 다운로드 (${done}/${fields.length})`;
  }

  async function downloadFinalPdf() {
    try {
      els.downloadBtn.disabled = true;
      const { PDFDocument } = window.PDFLib;
      const pdfDoc = await PDFDocument.load(state.pdfBytes.slice());
      const fields = (state.meta && state.meta.fields) || [];

      for (const field of fields) {
        const sig = state.signatures[field.id];
        if (!sig || !sig.image) {
          continue;
        }
        const page = pdfDoc.getPage(field.page - 1);
        const pw = page.getWidth();
        const ph = page.getHeight();
        const rect = currentRect(field);
        const boxX = rect.x * pw;
        const boxY = ph - (rect.y + rect.h) * ph;
        const boxW = rect.w * pw;
        const boxH = rect.h * ph;

        const bytes = dataUrlToBytes(sig.image);
        const embedded = sig.image.startsWith("data:image/jpeg")
          ? await pdfDoc.embedJpg(bytes)
          : await pdfDoc.embedPng(bytes);

        const scale = Math.min(boxW / embedded.width, boxH / embedded.height);
        const drawW = embedded.width * scale;
        const drawH = embedded.height * scale;
        const drawX = boxX + (boxW - drawW) / 2;
        const drawY = boxY + (boxH - drawH) / 2;
        page.drawImage(embedded, { x: drawX, y: drawY, width: drawW, height: drawH });
      }

      const out = await pdfDoc.save();
      const blob = new Blob([out], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(state.meta.pdfName || "document").replace(/\.pdf$/i, "")}-signed.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      alert("PDF 합성 실패: " + (error && error.message ? error.message : "오류"));
    } finally {
      updateProgress();
    }
  }

  // ---- overrides 저장 ----
  function overridesKey(envelopeId) {
    return `signflow-overrides-${envelopeId}`;
  }
  function loadOverrides(envelopeId) {
    try {
      return JSON.parse(localStorage.getItem(overridesKey(envelopeId)) || "{}");
    } catch (error) {
      return {};
    }
  }
  function saveOverrides(envelopeId, overrides) {
    try {
      localStorage.setItem(overridesKey(envelopeId), JSON.stringify(overrides));
    } catch (error) {
      console.error(error);
    }
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(",")[1] || "";
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
})();
