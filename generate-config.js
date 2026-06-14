/*
 * 빌드 시 환경변수 -> firebase-config.js 생성.
 * Vercel: Build Command 에 "node generate-config.js" 를 지정하고
 *         아래 환경변수를 프로젝트 Settings > Environment Variables 에 등록한다.
 *
 *   FIREBASE_API_KEY
 *   FIREBASE_AUTH_DOMAIN
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_STORAGE_BUCKET
 *   FIREBASE_MESSAGING_SENDER_ID
 *   FIREBASE_APP_ID
 *
 * 환경변수가 하나라도 없으면 기존 firebase-config.js를 그대로 두고 종료한다
 * (라이브 사이트가 깨지지 않도록).
 */
const fs = require("fs");
const path = require("path");

const FIELDS = {
  apiKey: "FIREBASE_API_KEY",
  authDomain: "FIREBASE_AUTH_DOMAIN",
  projectId: "FIREBASE_PROJECT_ID",
  storageBucket: "FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "FIREBASE_MESSAGING_SENDER_ID",
  appId: "FIREBASE_APP_ID"
};

const config = {};
const missing = [];
for (const [field, envName] of Object.entries(FIELDS)) {
  const value = process.env[envName];
  if (value) {
    config[field] = value;
  } else {
    missing.push(envName);
  }
}

const outPath = path.join(__dirname, "firebase-config.js");

if (missing.length > 0) {
  console.warn("[generate-config] 환경변수 누락:", missing.join(", "));
  console.warn("[generate-config] 기존 firebase-config.js를 그대로 사용합니다.");
  process.exit(0);
}

const content =
  "// 자동 생성됨 (generate-config.js). 직접 수정하지 마세요.\n" +
  "window.FIREBASE_CONFIG = " + JSON.stringify(config, null, 2) + ";\n";

fs.writeFileSync(outPath, content);
console.log("[generate-config] firebase-config.js 생성 완료 (환경변수 주입)");
