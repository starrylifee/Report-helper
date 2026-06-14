/*
 * 관리자용 진행 현황 페이지.
 * URL: status.html?env=<envelopeId>
 * - 서명자별/영역별 진행 상황을 실시간으로 표시.
 * - 모든(또는 일부) 서명을 PDF에 합성해 최종 PDF로 다운로드.
 */
(function () {
  const { PDFDocument } = window.PDFLib;
  const params = new URLSearchParams(location.search);
  const envelopeId = params.get("env");

  const els = {
    docName: document.getElementById("docName"),
    overall: document.getElementById("overallProgress"),
    body: document.getElementById("statusBody"),
    message: document.getElementById("statusMessage"),
    downloadBtn: document.getElementById("downloadButton")
  };

  const state = {
    meta: null,
    pdfBytes: null,
    signatures: {}
  };

  bootstrap();

  async function bootstrap() {
    if (!window.SignFlow || !window.SignFlow.available) {
      els.message.textContent = "Firebase에 연결하지 못했어요.";
      return;
    }
    if (!envelopeId) {
      els.message.textContent = "문서 ID가 없습니다. 올바른 현황 링크인지 확인하세요.";
      return;
    }

    els.downloadBtn.addEventListener("click", downloadFinalPdf);

    try {
      const { meta, pdfBytes } = await window.SignFlow.getEnvelope(envelopeId);
      state.meta = meta;
      state.pdfBytes = pdfBytes;
      els.docName.textContent = meta.pdfName || "문서";

      window.SignFlow.watchSignatures(envelopeId, (map) => {
        state.signatures = map;
        render();
      });
    } catch (error) {
      console.error(error);
      els.message.textContent = "문서를 불러올 수 없습니다. 링크를 확인하세요.";
    }
  }

  function render() {
    const meta = state.meta;
    const fields = meta.fields || [];
    const signers = meta.signers || [];

    const totalDone = fields.filter((field) => state.signatures[field.id]).length;
    els.overall.textContent = `전체 ${totalDone} / ${fields.length} 서명 완료`;
    els.downloadBtn.disabled = totalDone === 0;
    els.downloadBtn.textContent = totalDone === fields.length
      ? "최종 PDF 다운로드"
      : `현재까지 PDF 다운로드 (${totalDone}/${fields.length})`;

    els.body.innerHTML = "";

    signers.forEach((signer) => {
      const myFields = fields.filter((field) => field.signerToken === signer.token);
      const done = myFields.filter((field) => state.signatures[field.id]).length;

      const card = document.createElement("div");
      card.className = "status-card";

      const head = document.createElement("div");
      head.className = "status-card-head";
      const name = document.createElement("strong");
      name.textContent = signer.name;
      const badge = document.createElement("span");
      badge.className = "status-badge " + (done === myFields.length ? "done" : "pending");
      badge.textContent = done === myFields.length ? "완료" : `${done}/${myFields.length}`;
      head.append(name, badge);
      card.appendChild(head);

      myFields.forEach((field) => {
        const sig = state.signatures[field.id];
        const row = document.createElement("div");
        row.className = "status-field-row";
        const label = document.createElement("span");
        label.textContent = `${field.page}페이지 서명란`;
        const when = document.createElement("span");
        when.className = "status-when";
        if (sig) {
          when.textContent = sig.signedAt && sig.signedAt.toDate
            ? "✅ " + formatTime(sig.signedAt.toDate())
            : "✅ 서명됨";
        } else {
          when.textContent = "대기 중";
        }
        row.append(label, when);
        card.appendChild(row);
      });

      els.body.appendChild(card);
    });
  }

  async function downloadFinalPdf() {
    try {
      els.downloadBtn.disabled = true;
      els.overall.textContent = "PDF 합성 중…";

      const pdfDoc = await PDFDocument.load(state.pdfBytes.slice());
      const fields = state.meta.fields || [];

      for (const field of fields) {
        const sig = state.signatures[field.id];
        if (!sig || !sig.image) {
          continue;
        }
        const page = pdfDoc.getPage(field.page - 1);
        const pw = page.getWidth();
        const ph = page.getHeight();
        const boxX = field.x * pw;
        const boxY = ph - (field.y + field.h) * ph;
        const boxW = field.w * pw;
        const boxH = field.h * ph;

        const bytes = dataUrlToBytes(sig.image);
        const embedded = sig.image.startsWith("data:image/jpeg")
          ? await pdfDoc.embedJpg(bytes)
          : await pdfDoc.embedPng(bytes);

        // 박스 안에 비율 유지(contain)로 배치
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

      render();
    } catch (error) {
      console.error(error);
      els.overall.textContent = "합성 실패: " + (error && error.message ? error.message : "오류");
      els.downloadBtn.disabled = false;
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

  function formatTime(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
})();
