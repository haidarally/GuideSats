import { useState } from "preact/hooks";
import { fmtSats, fmtTime, post, short, type State } from "./api";
import type { Lang, Strings } from "./i18n";

interface Props { s: State; t: Strings; lang: Lang; onError: (e: unknown) => void; refresh: () => void }

export function Guide({ s, t, lang, onError, refresh }: Props) {
  const [gid, setGid] = useState(s.guides[0]?.id ?? "");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const g = s.guides.find((x) => x.id === gid) ?? s.guides[0];
  if (!g) return null;
  const mine = s.bookings.filter((b) => b.guideId === g.id);
  return (
    <section>
      <label class="label" for="guide-select">{t.guideChoose}</label>
      <select id="guide-select" value={g.id} onChange={(e) => setGid((e.target as HTMLSelectElement).value)}>
        {s.guides.map((x) => <option key={x.id} value={x.id}>{x.displayName} · {x.area}</option>)}
      </select>

      <div class="wallet card">
        <div class="label">{t.received}</div>
        <div class="big" data-testid="guide-balance">{fmtSats(g.balanceSats)} <small>{t.sats}</small></div>
        <div class="muted"><code>{short(g.payeePubkey)}</code> · {g.languages.join(" / ")}</div>
      </div>

      <h2>{t.guideBookings}</h2>
      {mine.length === 0 ? <p class="muted">—</p> : (
        <ul class="list">
          {[...mine].reverse().map((b) => {
            const tour = s.tours.find((x) => x.id === b.tourId)!;
            return (
              <li class={`card state-${b.state}`} key={b.id}>
                <div class="row">
                  <strong>{tour.title[lang]}</strong>
                  <span class="amt">{fmtSats(b.priceSats)} {t.sats}</span>
                </div>
                <div class="muted">{t.starts}: {fmtTime(b.tourStart, lang)}</div>
                <div class={`pill pill-${b.state}`}>{t.state[b.state] ?? b.state}</div>
                {b.invoice && <div class="muted mono">{short(b.invoice, 14)}</div>}
                {b.state === "locked" && (
                  <form
                    class="actions"
                    onSubmit={(e) => {
                      e.preventDefault();
                      post(`/api/guide/bookings/${b.id}/settle`, { preimage: (codes[b.id] ?? "").replace(/\s+/g, "") }).then(refresh, onError);
                    }}
                  >
                    <input
                      aria-label={t.enterCode}
                      placeholder={t.enterCode}
                      inputMode="text"
                      autocomplete="off"
                      data-testid="guide-code"
                      value={codes[b.id] ?? ""}
                      onInput={(e) => setCodes({ ...codes, [b.id]: (e.target as HTMLInputElement).value })}
                    />
                    <button type="submit" data-testid="settle">{t.settle}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2>{t.incoming}</h2>
      {g.transactions.length === 0 ? <p class="muted">{t.noHistory}</p> : (
        <ul class="list tx">
          {g.transactions.map((x) => (
            <li key={x.paymentHash + x.at} class="row">
              <span>+{fmtSats(x.amountSats)} {t.sats}</span>
              <span class={`pill pill-tx-${x.state}`}>{t.tx[x.state] ?? x.state}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
