import { useState } from "preact/hooks";
import { fmtSats, fmtTime, makeSecret, post, readSecret, short, type Booking, type State } from "./api";
import type { Lang, Strings } from "./i18n";

interface Props { s: State; t: Strings; lang: Lang; onError: (e: unknown) => void; refresh: () => void }

function MeetingCode({ bookingId, t }: { bookingId: string; t: Strings }) {
  const p = readSecret(bookingId);
  const [copied, setCopied] = useState(false);
  if (!p) return <p class="muted">{t.meetingCodeMissing}</p>;
  return (
    <div class="code">
      <div class="label">{t.meetingCode}</div>
      <code data-testid="meeting-code">{p.match(/.{1,8}/g)!.join(" ")}</code>
      <button class="ghost" onClick={() => navigator.clipboard?.writeText(p).then(() => setCopied(true))}>
        {copied ? t.copied : t.copy}
      </button>
    </div>
  );
}

function BookingCard({ b, s, t, lang, onError, refresh }: Props & { b: Booking }) {
  const tour = s.tours.find((x) => x.id === b.tourId)!;
  const act = (f: () => Promise<unknown>) => () => f().then(refresh, onError);
  return (
    <li class={`card state-${b.state}`} data-testid={`booking-${b.id}`}>
      <div class="row">
        <strong>{tour.title[lang]}</strong>
        <span class="amt">{fmtSats(b.priceSats)} {t.sats}</span>
      </div>
      <div class="muted">
        {t.starts}: {fmtTime(b.tourStart, lang)} · {t.meet}: {tour.meetingPoint[lang]}
      </div>
      <div class={`pill pill-${b.state}`}>{t.state[b.state] ?? b.state}</div>
      <div class="muted small">{b.mode === "hold" ? t.modeHold : t.modeAfter}</div>
      {b.mandate && (b.state === "proposed" || b.state === "mandated") && (
        <div class="mandate">
          <div class="label">{t.mandate}</div>
          <dl>
            <dt>{t.cap}</dt>
            <dd>{fmtSats(b.mandate.capSats)} {t.sats}</dd>
            <dt>{t.payee}</dt>
            <dd><code>{short(b.mandate.payeePubkey)}</code></dd>
            <dt>{t.window}</dt>
            <dd>{fmtTime(b.mandate.notBefore, lang)} → {fmtTime(b.mandate.notAfter, lang)}</dd>
            <dt>{t.singleUse}</dt>
            <dd>✓</dd>
          </dl>
        </div>
      )}
      {b.state === "proposed" && (
        <>
          <p class="hint">{t.approveHint}</p>
          <div class="actions">
            <button
              data-testid="approve"
              onClick={act(async () => post(`/api/traveller/bookings/${b.id}/approve`, b.mode === "hold" ? { paymentHash: await makeSecret(b.id) } : {}))}
            >
              {t.approve}
            </button>
            <button class="ghost" onClick={act(() => post(`/api/traveller/bookings/${b.id}/cancel`))}>{t.cancel}</button>
          </div>
        </>
      )}
      {b.state === "mandated" && b.mode === "on_completion" && (
        <div class="actions">
          {b.confirmedAt ? (
            <button data-testid="ask-agent-pay" onClick={act(() => post("/api/agent/run", { bookingId: b.id }))}>{t.askAgentPay}</button>
          ) : s.now >= b.tourStart ? (
            <button data-testid="confirm-tour" onClick={act(() => post(`/api/traveller/bookings/${b.id}/confirm`))}>{t.confirmTour}</button>
          ) : (
            <p class="hint">{t.waitTour}</p>
          )}
          <button class="ghost" onClick={act(() => post(`/api/traveller/bookings/${b.id}/cancel`))}>{t.cancel}</button>
        </div>
      )}
      {b.state === "mandated" && b.mode === "hold" && (
        <div class="actions">
          <button data-testid="ask-agent" onClick={act(() => post("/api/agent/run", { bookingId: b.id }))}>{t.askAgentLock}</button>
          <button class="ghost" onClick={act(() => post(`/api/traveller/bookings/${b.id}/cancel`))}>{t.cancel}</button>
        </div>
      )}
      {b.state === "locked" && <MeetingCode bookingId={b.id} t={t} />}
    </li>
  );
}

export function Traveller(props: Props) {
  const { s, t, lang, onError, refresh } = props;
  const w = s.traveller;
  return (
    <section>
      <div class="wallet card">
        <div class="label">{t.balance}</div>
        <div class="big" data-testid="traveller-balance">{fmtSats(w.balanceSats)} <small>{t.sats}</small></div>
        <div class="muted">{w.budget ? `${t.budget}: ${fmtSats(w.budget.usedSats)} / ${fmtSats(w.budget.totalSats)} ${t.sats}` : t.noBudget}</div>
      </div>

      <h2>{t.bookings}</h2>
      {s.bookings.length === 0 ? <p class="muted">{t.noBookings}</p> : (
        <ul class="list">{[...s.bookings].reverse().map((b) => <BookingCard key={b.id} b={b} {...props} />)}</ul>
      )}

      <h2>{t.tours}</h2>
      <ul class="list">
        {s.tours.map((tour) => (
          <li class="card" key={tour.id}>
            <div class="row">
              <strong>{tour.title[lang]}</strong>
              <span class="amt">{fmtSats(tour.priceSats)} {t.sats}</span>
            </div>
            <div class="muted">{s.guides.find((g) => g.id === tour.guideId)?.displayName} · {fmtTime(tour.startAt, lang)} · {tour.durationHours} h</div>
            <div class="actions">
              <button data-testid={`book-${tour.id}`} onClick={() => post("/api/traveller/bookings", { tourId: tour.id }).then(refresh, onError)}>{t.book}</button>
              <button class="ghost" data-testid={`book-after-${tour.id}`} onClick={() => post("/api/traveller/bookings", { tourId: tour.id, mode: "on_completion" }).then(refresh, onError)}>
                {t.bookAfter}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>{t.history}</h2>
      {w.transactions.length === 0 ? <p class="muted">{t.noHistory}</p> : (
        <ul class="list tx">
          {w.transactions.map((x) => (
            <li key={x.paymentHash + x.at} class="row">
              <span>{x.direction === "out" ? "−" : "+"}{fmtSats(x.amountSats)} {t.sats}</span>
              <span class={`pill pill-tx-${x.state}`}>{t.tx[x.state] ?? x.state}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
