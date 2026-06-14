/*
 * Firebase 초기화 + Firestore 데이터 계층.
 * 기존 app.js가 전역(window.pdfjsLib 등)을 쓰는 구조에 맞춰 compat SDK를 전역으로 로드한다.
 * Cloud Storage(Blaze 필요)는 쓰지 않고, PDF를 Firestore에 base64 청크로 저장한다.
 *
 * 노출 API: window.SignFlow
 */
(function () {
  // 설정은 firebase-config.js(window.FIREBASE_CONFIG)에서 주입된다.
  // 로컬/Firebase Hosting: 저장소에 커밋된 firebase-config.js 사용.
  // Vercel: 빌드 시 generate-config.js가 환경변수로 firebase-config.js를 덮어씀.
  const firebaseConfig = window.FIREBASE_CONFIG;

  if (!window.firebase || !window.firebase.firestore) {
    console.error("[SignFlow] Firebase compat SDK가 로드되지 않았습니다. index.html 스크립트 순서를 확인하세요.");
    window.SignFlow = { available: false };
    return;
  }

  if (!firebaseConfig || !firebaseConfig.apiKey) {
    console.error("[SignFlow] FIREBASE_CONFIG가 없습니다. firebase-config.js 로드 여부/환경변수를 확인하세요.");
    window.SignFlow = { available: false };
    return;
  }

  firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();
  const FieldValue = firebase.firestore.FieldValue;
  // 인증은 auth SDK가 로드된 페이지(관리자 index.html)에서만 사용. 서명자 페이지엔 없음.
  const auth = firebase.auth ? firebase.auth() : null;

  // Firestore 문서 1MiB 한도를 고려해 청크당 700KB(base64 문자) 정도로 자른다.
  const CHUNK_SIZE = 700000;

  // ---- 인코딩 헬퍼 (스택 오버플로 없이 대용량 처리) ----
  function bytesToBase64(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function randomToken(length = 24) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const values = new Uint32Array(length);
    crypto.getRandomValues(values);
    let token = "";
    for (let i = 0; i < length; i += 1) {
      token += alphabet[values[i] % alphabet.length];
    }
    return token;
  }

  // ---- 봉투(Envelope) 생성 ----
  // params: { pdfBytes:Uint8Array, pdfName, pageCount, signers:[{name,token}], fields:[...] }
  async function createEnvelope(params) {
    const envelopeId = randomToken(28); // 추측불가 비밀키 역할
    const base64 = bytesToBase64(params.pdfBytes);
    const chunks = [];
    for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
      chunks.push(base64.slice(i, i + CHUNK_SIZE));
    }

    const envelopeRef = db.collection("envelopes").doc(envelopeId);

    const batch = db.batch();
    batch.set(envelopeRef, {
      pdfName: params.pdfName || "document.pdf",
      pageCount: params.pageCount || 0,
      chunkCount: chunks.length,
      signers: params.signers || [],
      fields: params.fields || [],
      createdAt: FieldValue.serverTimestamp()
    });
    chunks.forEach((data, index) => {
      const chunkRef = envelopeRef.collection("pdfChunks").doc(String(index));
      batch.set(chunkRef, { index, data });
    });
    await batch.commit();

    return { envelopeId };
  }

  // ---- 봉투 메타 + PDF 복원 ----
  async function getEnvelope(envelopeId) {
    const snap = await db.collection("envelopes").doc(envelopeId).get();
    if (!snap.exists) {
      throw new Error("envelope not found");
    }
    const meta = snap.data();

    const chunkSnap = await db
      .collection("envelopes").doc(envelopeId)
      .collection("pdfChunks").orderBy("index").get();
    let base64 = "";
    chunkSnap.forEach((doc) => {
      base64 += doc.data().data;
    });
    const pdfBytes = base64ToBytes(base64);

    return { meta, pdfBytes };
  }

  // ---- 서명 제출 ----
  async function submitSignature(envelopeId, fieldId, payload) {
    const ref = db
      .collection("envelopes").doc(envelopeId)
      .collection("signatures").doc(fieldId);
    await ref.set({
      image: payload.image,
      signerToken: payload.signerToken,
      signedAt: FieldValue.serverTimestamp()
    });
  }

  // ---- 봉투(서명 프로젝트) 완전 삭제 ----
  async function deleteEnvelope(envelopeId) {
    const envRef = db.collection("envelopes").doc(envelopeId);
    // 서브컬렉션(PDF 청크, 서명) 먼저 삭제
    for (const sub of ["pdfChunks", "signatures"]) {
      const snap = await envRef.collection(sub).get();
      let batch = db.batch();
      let count = 0;
      for (const doc of snap.docs) {
        batch.delete(doc.ref);
        count += 1;
        if (count === 450) {
          await batch.commit();
          batch = db.batch();
          count = 0;
        }
      }
      if (count > 0) {
        await batch.commit();
      }
    }
    await envRef.delete();
  }

  // ---- 서명 현황 실시간 구독 ----
  function watchSignatures(envelopeId, callback) {
    return db
      .collection("envelopes").doc(envelopeId)
      .collection("signatures")
      .onSnapshot((snapshot) => {
        const map = {};
        snapshot.forEach((doc) => {
          map[doc.id] = doc.data();
        });
        callback(map);
      });
  }

  window.SignFlow = {
    available: true,
    db,
    createEnvelope,
    getEnvelope,
    submitSignature,
    deleteEnvelope,
    watchSignatures,
    randomToken,
    bytesToBase64,
    base64ToBytes,
    // ---- 인증 (관리자 페이지 전용) ----
    auth: !!auth,
    onAuth: function (callback) {
      if (auth) {
        return auth.onAuthStateChanged(callback);
      }
      callback(null);
      return function () {};
    },
    signInWithGoogle: function () {
      if (!auth) {
        return Promise.reject(new Error("auth unavailable"));
      }
      const provider = new firebase.auth.GoogleAuthProvider();
      return auth.signInWithPopup(provider);
    },
    signOut: function () {
      return auth ? auth.signOut() : Promise.resolve();
    },
    getUser: function () {
      return auth ? auth.currentUser : null;
    }
  };
})();
