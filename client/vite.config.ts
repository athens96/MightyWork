import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true, // 포트가 사용 중이면 다른 포트로 넘어가지 않고 실패(구글 승인 원본과 일치해야 함)
    // 개발 중에는 /api 요청을 파이썬 서버로 프록시
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
