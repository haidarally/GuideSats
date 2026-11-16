import { useState } from "preact/hooks";
import { post, type State } from "./api";
import type { Strings } from "./i18n";

export interface LogLine { at: number; text: string; ok?: boolean }

interface Props { s: State; t: Strings; log: LogLine[]; onError: (e: unknown) => void; refresh: () => void }

export function Agent({ s, t, log, onError, refresh }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (body: unknown) => {
    setBusy(true);
    post("/api/agent/run", body).then(refresh, onError).finally(() => setBusy(false));
  };
  return (
    <section>
      <p class="hint">{t.agentRules}</p>
      <form
        class="actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) run({ text });
        }}
      >
        <input aria-label={t.agentPrompt} placeholder={t.agentPlaceholder} value={text} maxLength={300} data-testid="agent-text" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button type="submit" disabled={busy} data-testid="agent-run">{t.run}</button>
      </form>

      <h2>{t.agentLog}</h2>
      <ol class="console" data-testid="agent-log">
        {log.length === 0 ? <li class="muted">…</li> : log.map((l, i) => <li key={i} class={l.ok === false ? "bad" : l.ok ? "good" : ""}>{l.text}</li>)}
      </ol>

      {s.simulated && (
        <div class="card demo">
          <div class="label">{t.demo}</div>
          <div class="actions wrap">
            <button class="warn" data-testid="cyclone" onClick={() => post("/api/demo/cyclone", { on: !s.cyclone.active }).then(refresh, onError)}>
              {s.cyclone.active ? t.cycloneOff : t.cycloneOn}
            </button>
            <button class="ghost" data-testid="attack" onClick={() => post("/api/demo/attack").then(refresh, onError)}>{t.attack}</button>
            <button class="ghost" data-testid="expire-invoice" onClick={() => post("/api/demo/expire-invoice").then(refresh, onError)}>{t.expireInvoice}</button>
            <button class="ghost" onClick={() => post("/api/demo/advance", { hours: 13 }).then(refresh, onError)}>{t.skip}</button>
            <button class="ghost" onClick={() => post("/api/demo/reset").then(refresh, onError)}>{t.reset}</button>
          </div>
        </div>
      )}
    </section>
  );
}
