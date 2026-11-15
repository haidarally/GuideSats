import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { getState, type State } from "./api";
import { STRINGS, type Lang } from "./i18n";
import { Traveller } from "./Traveller";
import { Guide } from "./Guide";
import { Agent, type LogLine } from "./Agent";

type Tab = "traveller" | "guide" | "agent";

const initialLang = (): Lang => {
  try {
    const saved = localStorage.getItem("guidesats:lang");
    if (saved === "en" || saved === "fr") return saved;
  } catch {
    /* ignore */
  }
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
};

function describe(step: { call?: { tool: string; args: Record<string, unknown> }; result?: { ok: boolean; error?: string; data?: unknown }; outcome?: string }): LogLine {
  if (step.outcome) return { at: Date.now(), text: `⇢ ${step.outcome}`, ok: step.outcome === "all_refused_by_the_mandate" || !/refused|failed|no_|unknown|SOMETHING/.test(step.outcome) };
  if (step.call) {
    const args = Object.entries(step.call.args).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(" ");
    const res = step.result?.ok ? "ok" : `refused: ${step.result?.error}`;
    return { at: Date.now(), text: `${step.call.tool}(${args}) → ${res}`, ok: step.result?.ok };
  }
  return { at: Date.now(), text: "agent started" };
}

function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [tab, setTab] = useState<Tab>("traveller");
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const t = STRINGS[lang];

  const refresh = useCallback(() => {
    getState().then(setS, (e) => setErr(String(e)));
  }, []);
  const onError = useCallback((e: unknown) => setErr(e instanceof Error ? e.message : String(e)), []);

  useEffect(() => {
    refresh();
    const es = new EventSource("/api/events");
    es.addEventListener("update", refresh);
    es.addEventListener("agent", (ev) => {
      setLog((l) => [...l.slice(-60), describe(JSON.parse((ev as MessageEvent).data))]);
      refresh();
    });
    return () => es.close();
  }, [refresh]);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("guidesats:lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  if (!s) return <main class="loading">…</main>;
  return (
    <>
      <header>
        <div class="brand">GuideSats <span class="muted">· Mauritius</span></div>
        <button class="ghost lang" data-testid="lang" onClick={() => setLang(lang === "en" ? "fr" : "en")} aria-label="Language / Langue">
          {lang === "en" ? "FR" : "EN"}
        </button>
      </header>
      {s.simulated && <div class="banner sim" data-testid="sim-banner">{t.simulated}</div>}
      <div class={`banner ${s.cyclone.active ? "storm" : "calm"}`} data-testid="cyclone-banner">
        {s.cyclone.active ? `🌀 ${t.cycloneActive}: ${s.cyclone.event?.name} (${s.cyclone.event?.alertlevel})` : t.cycloneNone}
      </div>
      {err && (
        <div class="banner error" role="alert" onClick={() => setErr(null)}>
          {t.error}: {err}
        </div>
      )}
      <nav role="tablist">
        {(["traveller", "guide", "agent"] as Tab[]).map((k) => (
          <button role="tab" aria-selected={tab === k} class={tab === k ? "active" : ""} data-testid={`tab-${k}`} onClick={() => setTab(k)}>
            {k === "traveller" ? t.tabTraveller : k === "guide" ? t.tabGuide : t.tabAgent}
          </button>
        ))}
      </nav>
      <main>
        {tab === "traveller" && <Traveller s={s} t={t} lang={lang} onError={onError} refresh={refresh} />}
        {tab === "guide" && <Guide s={s} t={t} lang={lang} onError={onError} refresh={refresh} />}
        {tab === "agent" && <Agent s={s} t={t} log={log} onError={onError} refresh={refresh} />}
      </main>
    </>
  );
}

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
