import { useEffect, useRef, useState } from "react";
import { wikiApi, type ExportFormat } from "../../api";
import { ApiError, saveBlob } from "../../api/http";

const ITEMS: { format: ExportFormat | "pdf"; label: string; hint: string }[] = [
  { format: "pdf", label: "PDF", hint: "인쇄 창에서 'PDF로 저장'" },
  { format: "docx", label: "Word", hint: ".docx" },
  { format: "hwpx", label: "한글", hint: ".hwpx (한글 2014 이상)" },
  { format: "hwp", label: "한글 (구버전)", hint: ".hwp" },
  { format: "html", label: "HTML", hint: "단독 웹 문서" },
  { format: "md", label: "Markdown", hint: "옵시디언 호환 (.md)" },
];

const PRESETS: { value: string; label: string }[] = [
  { value: "", label: "자동 (회의록 타입이면 회의록)" },
  { value: "report", label: "보고서" },
  { value: "minutes", label: "회의록" },
  { value: "plan", label: "계획서" },
  { value: "gaejosik", label: "개조식 (표지·목차)" },
  { value: "official", label: "기안문" },
  { value: "notice", label: "통지" },
  { value: "press", label: "보도자료" },
];

/** 위키 페이지 '내보내기' 메뉴 — PDF·Word·한글·HTML·Markdown, 하위 페이지 포함, 한글 양식 */
export function ExportMenu({ projectId, pageId, hasChildren }: { projectId: string; pageId: string; hasChildren: boolean }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState(false);
  const [preset, setPreset] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const run = async (format: ExportFormat | "pdf") => {
    setError(null);
    setBusy(format);
    // 팝업 차단을 피하려고 클릭 시점에 창을 먼저 연다 (PDF: 인쇄용 HTML 을 그 창에 띄움)
    const win = format === "pdf" ? window.open("", "_blank") : null;
    try {
      if (format === "pdf") {
        const { blob } = await wikiApi.export(projectId, pageId, { format: "html", children, print: true });
        if (win) win.location.href = URL.createObjectURL(blob);
      } else {
        const { blob, filename } = await wikiApi.export(projectId, pageId, { format, children, preset: preset || undefined });
        saveBlob(blob, filename);
      }
      setOpen(false);
    } catch (e) {
      win?.close();
      setError(e instanceof ApiError ? String(e.detail) : "내보내기에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="btn btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        내보내기 ▾
      </button>
      {open && (
        <div className="popover export-menu" role="menu">
          {ITEMS.map((it) => (
            <button key={it.format} role="menuitem" className="menu-item" disabled={!!busy} onClick={() => run(it.format)}>
              <span>{it.label}</span>
              <span className="muted">{busy === it.format ? "만드는 중…" : it.hint}</span>
            </button>
          ))}
          <div className="menu-sep" />
          {hasChildren && (
            <label className="menu-option">
              <input type="checkbox" checked={children} onChange={(e) => setChildren(e.target.checked)} /> 하위 페이지 포함
            </label>
          )}
          <label className="menu-option">
            한글 양식
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error menu-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
