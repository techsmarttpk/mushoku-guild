// Mermaid diagrams inside Markdown. Isolated on purpose: the library is loaded on first use (separate chunk),
// rendering is wrapped so one bad diagram cannot take down the document, and only Mermaid fences ever get here.
import { Component, useEffect, useState, type ReactNode } from "react";

type MermaidApi = typeof import("mermaid").default;
let loading: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((m) => {
    const mermaid = m.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // labels are encoded and the SVG is sanitised: Markdown can not inject HTML or script
      theme: "base",
      themeVariables: {
        background: "#f5e6c4",
        primaryColor: "#f0d9a8",
        primaryBorderColor: "#8a5a34",
        primaryTextColor: "#3a2417",
        secondaryColor: "#e3cb9f",
        tertiaryColor: "#f5e6c4",
        lineColor: "#5c3a22",
        textColor: "#3a2417",
        noteBkgColor: "#fff2a8",
        noteTextColor: "#3a2417",
        fontFamily: "Segoe UI, Arial, sans-serif",
        fontSize: "14px",
      },
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      er: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
    });
    return mermaid;
  });
  return loading;
}

let seq = 0;

/** SVG produced by Mermaid's strict mode should never contain these; refuse it if it somehow does. */
export function svgLooksSafe(svg: string): boolean {
  return !/<script|javascript:|\son[a-z]+\s*=|<iframe|<object|<embed/i.test(svg);
}

export function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let live = true;
    setSvg(null);
    setError(null);
    void (async () => {
      const id = `mg-mermaid-${++seq}`;
      try {
        const mermaid = await loadMermaid();
        await mermaid.parse(source); // syntax errors are reported without leaving debris in the page
        const out = await mermaid.render(id, source);
        if (!live) return;
        if (!svgLooksSafe(out.svg)) throw new Error("The diagram contained active content and was not displayed.");
        setSvg(out.svg);
      } catch (e) {
        document.getElementById(`d${id}`)?.remove();
        if (live) setError((e instanceof Error ? e.message : String(e)).split("\n").slice(0, 6).join("\n"));
      }
    })();
    return () => {
      live = false;
    };
  }, [source]);

  const showCode = showSource || error !== null;
  return (
    <div className="mermaid-block">
      <div className="mermaid-bar">
        <span className="tag">Mermaid</span>
        <button className="link" onClick={() => setShowSource((v) => !v)} disabled={error !== null}>
          {showCode && error === null ? "Show diagram" : "Show source"}
        </button>
        {!showCode && svg && (
          <>
            <button className="link" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(1)))} aria-label="Zoom out">
              −
            </button>
            <span className="small">{Math.round(zoom * 100)}%</span>
            <button className="link" onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))} aria-label="Zoom in">
              +
            </button>
            <button className="link" onClick={() => setZoom(1)}>
              reset
            </button>
          </>
        )}
      </div>
      {error !== null && (
        <div className="note note-error" role="alert">
          <strong>This diagram could not be drawn.</strong>
          <pre className="mermaid-err">{error}</pre>
        </div>
      )}
      {showCode ? (
        <pre className="code md-code" data-lang="mermaid">{source}</pre>
      ) : svg ? (
        <div className="mermaid-view" tabIndex={0} aria-label="Diagram. Scroll to pan, use the zoom buttons to resize.">
          <div className="mermaid-svg" style={{ zoom }} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      ) : (
        <div className="muted small pad">Drawing diagram…</div>
      )}
    </div>
  );
}

/** One diagram failing must never break the viewer. */
export class MermaidBoundary extends Component<{ source: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? <pre className="code md-code" data-lang="mermaid">{this.props.source}</pre> : <MermaidBlock source={this.props.source} />;
  }
}
