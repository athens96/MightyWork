import { useCallback, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "mightywork.theme";

/** index.html 의 인라인 스크립트가 첫 페인트 전에 data-theme 을 설정한다. 여기서는 그 값을 읽고 바꾼다. */
function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(KEY, next);
    setTheme(next);
  }, []);
  return [theme, toggle];
}
