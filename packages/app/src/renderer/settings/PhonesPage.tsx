import type { PairedPhone, PhonePairingState } from '@ted/protocol'
import { Clock, Smartphone } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useMemo, useRef, useState } from 'react'
import dialogStyles from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { usePolledResource } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import { formatDate, formatTime } from '../time.ts'
import { Button, SettingsGroup, SettingsPage } from './controls.tsx'
import styles from './phones.module.css'

const dayMs = 24 * 60 * 60_000

export function pairedLine(phone: PairedPhone, now: number): string {
  const paired = `Paired ${formatDate(phone.pairedAt, { day: 'numeric', month: 'long' })}`
  if (phone.lastReachedAt === undefined) return paired
  return `${paired} · last reached ${reachedText(phone.lastReachedAt, now)}`
}

function reachedText(at: string, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const time = Date.parse(at)
  if (time >= startOfToday) return formatTime(at)
  const days = Math.max(1, Math.ceil((startOfToday - time) / dayMs))
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return `${Math.floor(days / 7)} weeks ago`
}

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

function QrCode({ text, faded }: { text: string; faded: boolean }) {
  const path = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
    let d = ''
    for (let row = 0; row < modules.size; row++) {
      for (let column = 0; column < modules.size; column++) {
        if (modules.get(row, column)) d += `M${column + 4} ${row + 4}h1v1h-1z`
      }
    }
    return { d, size: modules.size + 8 }
  }, [text])
  return (
    <div className={`${styles.qrFrame} ${faded ? styles.faded : ''}`}>
      <svg
        className={styles.qr}
        viewBox={`0 0 ${path.size} ${path.size}`}
        role="img"
        aria-label="Pairing QR code"
        shapeRendering="crispEdges"
      >
        <rect className={styles.qrBackground} width={path.size} height={path.size} />
        <path className={styles.qrModules} d={path.d} />
      </svg>
    </div>
  )
}

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

function PairDialog({
  state,
  onClose,
  onRenew,
  busy,
}: {
  state: PhonePairingState
  onClose: () => void
  onRenew: () => void
  busy: boolean
}) {
  const live = state.state === 'live'
  const now = useNow(live)
  const expired = state.state === 'expired' || (state.state === 'live' && state.expiresAt <= now)
  const link = state.state === 'live' ? state.link : undefined
  return (
    <Dialog onClose={onClose} className={styles.dialog}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogStyles.heading}>
            Pair a phone
          </h2>
          <p className={dialogStyles.body}>
            {expired
              ? 'This code has expired. Make a new one to pair a phone.'
              : 'Open Ted on your iPhone and scan this code.'}
          </p>
          {link !== undefined || expired ? (
            <QrCode text={link ?? 'ted-pair:expired'} faded={expired} />
          ) : (
            <div className={styles.qrFrame} />
          )}
          {expired ? (
            <p className={`${styles.timer} ${styles.expired}`}>
              <Clock size={12} aria-hidden /> Expired
            </p>
          ) : (
            state.state === 'live' && (
              <p className={styles.timer}>
                <Clock size={12} aria-hidden /> Works once · {countdown(state.expiresAt - now)} left
              </p>
            )
          )}
          <div className={dialogStyles.buttons}>
            {!expired && state.state === 'live' && state.edition === 'dev' && (
              <Button onClick={() => void ted.copyText(state.link)}>Copy code</Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            {expired && (
              <Button primary disabled={busy} onClick={onRenew}>
                Make a new code
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog>
  )
}

function ApproveDialog({
  state,
  busy,
  onApprove,
  onRefuse,
}: {
  state: Extract<PhonePairingState, { state: 'waiting' }>
  busy: boolean
  onApprove: () => void
  onRefuse: () => void
}) {
  return (
    <Dialog onClose={onRefuse} className={styles.dialog}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogStyles.heading}>
            {`Approve “${state.phoneName}”?`}
          </h2>
          <p className={dialogStyles.body}>
            {`A phone named “${state.phoneName}” scanned the code. Approve it only if it’s your phone and it shows the same code.`}
          </p>
          <p className={styles.code} data-code={state.code}>
            {spacedCode(state.code)}
          </p>
          <p className={styles.note}>
            Once approved, the phone can see and answer every request in every Factory on this Mac.
          </p>
          <div className={dialogStyles.buttons}>
            <Button disabled={busy} onClick={onRefuse}>
              Refuse
            </Button>
            <Button primary disabled={busy} onClick={onApprove}>
              Approve
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function PhonesPage() {
  const phones = usePolledResource(ted.pairedPhones, 5000)
  const [pairing, setPairing] = useState<PhonePairingState>()
  const [removing, setRemoving] = useState<PairedPhone>()
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const now = useNow(true)
  const open = pairing !== undefined && pairing.state !== 'none'
  const pairingId = pairing && 'pairing' in pairing ? pairing.pairing : undefined
  const reload = useRef(phones.reload)
  reload.current = phones.reload

  useEffect(
    () =>
      ted.onEvent((event) => {
        if (event.type === 'phones-changed') reload.current()
      }),
    [],
  )

  useEffect(() => {
    if (!open) return
    let active = true
    const timer = setInterval(() => {
      void ted.currentPhonePairing().then(
        (next) => {
          if (active) setPairing((shown) => (shown === undefined ? shown : next))
        },
        () => undefined,
      )
    }, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [open])

  useEffect(() => {
    if (pairing?.state === 'approved' || pairing?.state === 'refused') {
      setPairing(undefined)
      reload.current()
    }
  }, [pairing])

  function act(work: () => Promise<void>) {
    setBusy(true)
    setProblem(undefined)
    void work()
      .catch((failure: Error) => setProblem(readableError(failure)))
      .finally(() => {
        setBusy(false)
        phones.reload()
      })
  }

  const start = () =>
    act(async () => {
      const offer = await ted.createPhonePairing()
      setPairing({ state: 'live', ...offer })
    })

  const close = () => {
    setPairing(undefined)
    act(async () => {
      await ted.cancelPhonePairing()
    })
  }

  const list = phones.value?.phones ?? []
  return (
    <SettingsPage
      title="Phones"
      subtitle="Answer Inbox requests from your iPhone when you’re away from this Mac. Requests reach the phone through an end-to-end encrypted relay. The Ted iPhone app is in testing. Get in touch if you’d like to try it."
    >
      {(problem ?? phones.error) && (
        <p className={styles.error} role="alert">
          {problem ?? phones.error}
        </p>
      )}
      <SettingsGroup
        setting="app.phones.paired"
        action={
          <Button primary disabled={busy} onClick={start}>
            Pair a phone…
          </Button>
        }
      >
        {list.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No phones paired yet</p>
            <p className={styles.emptyText}>
              Choose Pair a phone, then scan the code with Ted on your iPhone.
            </p>
          </div>
        ) : (
          list.map((phone) => (
            <div key={phone.id} className={styles.row} data-nav-item tabIndex={-1}>
              <span className={styles.icon}>
                <Smartphone size={14} aria-hidden />
              </span>
              <div className={styles.rowText}>
                <span className={styles.name}>{phone.name}</span>
                <span className={styles.detail}>{pairedLine(phone, now)}</span>
              </div>
              <Button disabled={busy} onClick={() => setRemoving(phone)}>
                Remove…
              </Button>
            </div>
          ))
        )}
      </SettingsGroup>
      {phones.value?.pairAgain && <p className={styles.footnote}>Pair your phones again.</p>}
      {list.length > 0 && (
        <p className={styles.footnote}>
          Each phone pairs with one Mac. Removing a phone stops its requests and notifications at
          once.
        </p>
      )}
      {open && pairing.state === 'waiting' && (
        <ApproveDialog
          state={pairing}
          busy={busy}
          onApprove={() =>
            act(async () => setPairing(await ted.approvePhonePairing({ pairing: pairing.pairing })))
          }
          onRefuse={() =>
            act(async () => setPairing(await ted.refusePhonePairing({ pairing: pairing.pairing })))
          }
        />
      )}
      {open && pairing.state !== 'waiting' && pairingId !== undefined && (
        <PairDialog state={pairing} busy={busy} onClose={close} onRenew={start} />
      )}
      {removing && (
        <Dialog onClose={() => setRemoving(undefined)} className={styles.dialog}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {`Remove “${removing.name}”?`}
              </h2>
              <p className={dialogStyles.body}>
                It stops getting requests and notifications at once. To use it again, pair it again.
              </p>
              <div className={dialogStyles.buttons}>
                <Button onClick={() => setRemoving(undefined)}>Cancel</Button>
                <Button
                  danger
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await ted.removePhone(removing.id)
                      setRemoving(undefined)
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </SettingsPage>
  )
}
