import { describe, expect, it, vi } from "vitest";
import { compareSemver, fetchRemoteVersion, isNewerVersion } from "./versionCheck";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("compareSemver & isNewerVersion", () => {
  it("major / minor / patch 상승을 정확히 판별한다", () => {
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.2.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("v0.2.0", "0.1.0")).toBe(true);
  });

  it("동일 버전이나 하위 버전은 false를 반환한다", () => {
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "1.0.0")).toBe(false);
  });

  it("프리릴리즈 우선순위(SemVer 2.0)와 잘못된 문자열을 안전하게 처리한다", () => {
    expect(isNewerVersion("0.2.0", "0.2.0-rc.1")).toBe(true);
    expect(isNewerVersion("0.2.0-rc.1", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.2.0-beta.10", "0.2.0-beta.2")).toBe(true);
    expect(compareSemver("not-a-ver", "0.1.0")).toBeNull();
    expect(isNewerVersion("not-a-ver", "0.1.0")).toBe(false);
  });
});

describe("fetchRemoteVersion", () => {
  it("/version.json 응답이 정상이면 우선 사용한다", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/version.json")) return jsonResponse({ name: "MightyWork", version: "0.2.0" });
      return jsonResponse({ name: "MightyWork", version: "0.1.0" });
    }) as unknown as typeof fetch;

    expect(await fetchRemoteVersion(fetcher)).toBe("0.2.0");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("/version.json 이 HTML(SPA fallback)이나 404면 /api/version 으로 폴백한다", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/version.json")) {
        return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
      if (url.startsWith("/api/version")) {
        return jsonResponse({ name: "MightyWork", version: "0.2.1" });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    expect(await fetchRemoteVersion(fetcher)).toBe("0.2.1");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("네트워크 오류 시 예외 대신 null을 반환한다", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    expect(await fetchRemoteVersion(fetcher)).toBeNull();
  });
});
