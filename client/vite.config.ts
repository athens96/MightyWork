import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

/** 빌드 시 dist/version.json 을 생성하고 dev 서버에서도 동일 경로를 제공해 새 배포 버전을 안전하게 감지한다. */
function versionJsonPlugin(): Plugin {
  return {
    name: "mightywork-version-json",
    configureServer(server) {
      server.middlewares.use("/version.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ name: "MightyWork", version: pkg.version }));
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ name: "MightyWork", version: pkg.version, built_at: new Date().toISOString() })}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionJsonPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5174,
    strictPort: true, // 포트가 사용 중이면 다른 포트로 넘어가지 않고 실패(구글 승인 원본과 일치해야 함)
    // 개발 중에는 /api 요청을 파이썬 서버로 프록시
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
