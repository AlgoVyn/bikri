import { normaliseNumericText } from '@bikri/core';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { getKv, setKv } from '../data/kv.ts';
import type { PrinterKv } from '../data/receipt.ts';
import {
  AGENT_DOWNLOADS,
  AGENT_PROTOCOL,
  AGENT_RELEASE_URL,
  AGENT_SHA256_URL,
  AGENT_URL,
  type AgentHealth,
  type AgentMode,
  type AgentPrinter,
  AgentRequestError,
  agentCompatible,
  agentPlatform,
  httpAgentClient,
} from '../print/agent.ts';
import { browserPrintDeps } from '../print/printDeps.ts';
import { errorCode, printTestPage } from '../print/printService.ts';
import {
  type PrintErrorCode,
  SERIAL_BAUD_RATES,
  type SerialPortLike,
  type UsbDeviceLike,
} from '../print/transports.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import {
  AGENT_PENDING_KEY,
  printerConnected,
  type SerialChoice,
  serialChoiceOf,
  withSerialChoice,
} from './printerWizardState.ts';

function isStaleAgentToken(error: unknown): boolean {
  return (
    error instanceof AgentRequestError &&
    (error.status === 401 || error.code === 'UNAUTHORIZED')
  );
}

type Step = 'paper' | 'connection' | 'test';
type Answer = 'yes' | 'no' | null;
const BAUDS = SERIAL_BAUD_RATES;

const choice = (on: boolean) =>
  `flex min-h-14 flex-1 flex-col items-start justify-center rounded-card border-2 p-3 text-start ${on ? 'border-primary bg-primary-subtle text-primary-subtle-ink' : 'border-border bg-surface'}`;

/** Compact radio choice for options nested under a paper width. */
const charsChoice = (on: boolean) =>
  `flex min-h-11 flex-1 cursor-pointer items-center gap-2 rounded-control border px-3 text-small ${on ? 'border-primary bg-primary-subtle text-primary-subtle-ink' : 'border-border bg-surface'}`;

function YesNo({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Answer;
  onChange: (a: Answer) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <fieldset
      className="flex flex-wrap items-center gap-2"
      aria-labelledby={id}
    >
      <legend id={id} className="w-full font-medium">
        {label}
      </legend>
      {(['yes', 'no'] as const).map((a) => (
        <label
          key={a}
          className={`${buttonQuiet} gap-2 ${value === a ? 'border-primary' : ''}`}
        >
          <input
            type="radio"
            name={id}
            checked={value === a}
            onChange={() => onChange(a)}
          />
          {t(a === 'yes' ? 'common.yes' : 'common.no')}
        </label>
      ))}
    </fieldset>
  );
}

/** Set up printer (06 §8): paper → connection → test print with three questions → save. */
export function PrinterWizard({
  current,
  onDone,
}: {
  current: PrinterKv | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { can, support } = useCurrentStaff();
  const readOnly = useReadOnly();
  const deps = browserPrintDeps();
  const agent = deps.agent ?? httpAgentClient;
  const platform = agentPlatform();
  const primaryDownload =
    platform === 'windows'
      ? 'windows'
      : platform === 'linux'
        ? 'linux'
        : platform === 'macos'
          ? 'macosArm'
          : null;
  const downloadKeys = [
    'windows',
    'linux',
    'linuxArm',
    'macos',
    'macosArm',
  ] as const;
  const desktop =
    typeof navigator === 'undefined' ||
    !/Mobi|Android/iu.test(navigator.userAgent);
  const [step, setStep] = useState<Step>('paper');
  const [draft, setDraft] = useState<PrinterKv>(() => {
    const paperMm = current?.paper_mm ?? 80;
    return {
      auto_print: true,
      copies: 1,
      print_logo: true,
      print_day_close: true,
      qr: false,
      drawer: true,
      drawer_pin: 2,
      cut: 'partial',
      ...current,
      paper_mm: paperMm,
      chars_per_line: current?.chars_per_line ?? (paperMm === 58 ? 32 : 48),
      dots: current?.dots ?? (paperMm === 58 ? 384 : 576),
      transport:
        current?.transport ??
        (deps.usb ? 'usb' : deps.serial ? 'serial' : 'system'),
    };
  });
  const [error, setError] = useState<PrintErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);
  const [ruler, setRuler] = useState<Answer>(null);
  const [urdu, setUrdu] = useState<Answer>(null);
  const [cut, setCut] = useState<Answer>(null);
  const [agentHealth, setAgentHealth] = useState<AgentHealth | null>(null);
  const [agentPrinters, setAgentPrinters] = useState<AgentPrinter[]>([]);
  const [agentCode, setAgentCode] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentChecking, setAgentChecking] = useState(true);
  const [serialChoice, setSerialChoice] = useState<SerialChoice>(() =>
    serialChoiceOf(current ?? {}),
  );
  const patch = (p: Partial<PrinterKv>) => setDraft((d) => ({ ...d, ...p }));
  const changeSerialChoice = (next: SerialChoice) => {
    setSerialChoice(next);
    setDraft((d) => withSerialChoice(d, next));
  };
  const patchAgent = (p: Partial<NonNullable<PrinterKv['agent']>>) =>
    setDraft((d) =>
      d.agent === undefined ? d : { ...d, agent: { ...d.agent, ...p } },
    );
  const rememberAgent = async (config: NonNullable<PrinterKv['agent']>) => {
    await setKv(getDb(), AGENT_PENDING_KEY, config);
  };

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void (async () => {
      // A pairing that completed before Save lives here: the agent already
      // dropped its one-time code and would answer ALREADY_PAIRED after a
      // reload, so recover the token instead of locking the shop out.
      const pending = current?.agent?.token
        ? null
        : await getKv<NonNullable<PrinterKv['agent']> | null>(
            getDb(),
            AGENT_PENDING_KEY,
            null,
          );
      const url = current?.agent?.url ?? pending?.url ?? AGENT_URL;
      if (pending && !current?.agent?.token) {
        setDraft((value) => ({
          ...value,
          transport: 'agent',
          agent: {
            ...pending,
            printerName: value.agent?.printerName || pending.printerName,
          },
        }));
      }
      setAgentChecking(true);
      let health: AgentHealth;
      try {
        health = await agent.health(url);
      } catch {
        if (!cancelled) {
          setAgentHealth(null);
          setAgentChecking(false);
        }
        return;
      }
      if (cancelled) return;
      setAgentHealth(health);
      setAgentChecking(false);
      if (!agentCompatible(health)) {
        setAgentError('agent_outdated');
        return;
      }
      if (!health.paired && health.pairingCode)
        setAgentCode(health.pairingCode);
      const token = current?.agent?.token ?? pending?.token;
      if (health.paired && token) {
        try {
          const list = await agent.printers(url, token);
          if (!cancelled) setAgentPrinters(list);
        } catch (err) {
          if (!cancelled) {
            if (isStaleAgentToken(err)) {
              setDraft((value) => {
                const next = { ...value };
                delete next.agent;
                return next;
              });
              await getDb().kv.delete(AGENT_PENDING_KEY);
              setAgentError('agent_already_paired');
            } else setAgentError('agent_unreachable');
          }
        }
      } else if (health.paired) {
        // A token in this browser was expected but is gone: only the agent's
        // own Unpair can start a new pairing.
        setAgentError('agent_already_paired');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent, current, desktop]);

  const checkAgent = async () => {
    setAgentBusy(true);
    setAgentChecking(true);
    setAgentError(null);
    try {
      const pending = draft.agent?.token
        ? null
        : await getKv<NonNullable<PrinterKv['agent']> | null>(
            getDb(),
            AGENT_PENDING_KEY,
            null,
          );
      const url = draft.agent?.url ?? pending?.url ?? AGENT_URL;
      const health = await agent.health(url);
      setAgentHealth(health);
      setAgentChecking(false);
      if (!agentCompatible(health)) {
        setAgentError('agent_outdated');
        return;
      }
      if (!health.paired && health.pairingCode)
        setAgentCode(health.pairingCode);
      if (health.paired) {
        const token = draft.agent?.token ?? pending?.token;
        if (token) {
          try {
            const list = await agent.printers(url, token);
            setAgentPrinters(list);
            if (!draft.agent?.token && pending) {
              patch({ transport: 'agent', agent: pending });
            }
          } catch (err) {
            if (isStaleAgentToken(err)) {
              setDraft((value) => {
                const next = { ...value };
                delete next.agent;
                return next;
              });
              await getDb().kv.delete(AGENT_PENDING_KEY);
              setAgentError('agent_already_paired');
            } else setAgentError('agent_unreachable');
          }
        } else {
          setAgentError('agent_already_paired');
        }
      }
    } catch {
      setAgentHealth(null);
      setAgentChecking(false);
      setAgentError('agent_unreachable');
    } finally {
      setAgentBusy(false);
    }
  };

  const pairAgent = async () => {
    setAgentBusy(true);
    setAgentError(null);
    try {
      if (!agentCompatible(agentHealth)) {
        setAgentError('agent_outdated');
        return;
      }
      const code = agentCode.trim() || agentHealth?.pairingCode || '';
      if (code.length !== 6) {
        setAgentError('agent_pair_failed');
        return;
      }
      const url = draft.agent?.url ?? AGENT_URL;
      const paired = await agent.pair(url, code, 'Bikri');
      const config = {
        url,
        token: paired.token,
        agentId: paired.agentId,
        printerName: '',
        mode: 'raw' as AgentMode,
      };
      // The agent forgets its pairing code and answers ALREADY_PAIRED from now
      // on. Persist the token before anything else can fail or be cancelled.
      await rememberAgent(config);
      patch({ transport: 'agent', agent: config });
      try {
        const health = await agent.health(url);
        setAgentHealth(health);
        if (!agentCompatible(health)) {
          setAgentError('agent_outdated');
          return;
        }
      } catch {
        setAgentHealth((health) => ({
          ...(health ?? {
            app: 'bikri-print-agent',
            version: agentHealth?.version ?? '',
            protocol: AGENT_PROTOCOL,
            platform: '',
            paired: true,
            printers: 0,
          }),
          paired: true,
          pairingCode: undefined,
        }));
      }
      try {
        const list = await agent.printers(url, paired.token);
        setAgentPrinters(list);
        const chosen = list.find((p) => p.isDefault) ?? list[0];
        if (chosen) {
          const selected = { ...config, printerName: chosen.name };
          await rememberAgent(selected);
          patch({ agent: selected });
        }
      } catch {
        setAgentError('agent_unreachable');
      }
      setAgentCode('');
    } catch (err) {
      setAgentError(
        err instanceof AgentRequestError && err.code === 'ALREADY_PAIRED'
          ? 'agent_already_paired'
          : 'agent_pair_failed',
      );
    } finally {
      setAgentBusy(false);
    }
  };

  const unpairAgent = async () => {
    const config = draft.agent;
    if (!config || !agentHealth) return;
    setAgentBusy(true);
    setAgentError(null);
    try {
      await agent.unpair(config.url, config.token);
      await getDb().kv.delete(AGENT_PENDING_KEY);
      setDraft((currentDraft) => {
        const next = { ...currentDraft };
        delete next.agent;
        return next;
      });
      setAgentPrinters([]);
      setAgentCode('');
      try {
        const health = await agent.health(config.url);
        setAgentHealth(health);
        setAgentCode(health.pairingCode ?? '');
      } catch {
        setAgentHealth(null);
        setAgentError('agent_unreachable');
      }
    } catch (err) {
      if (isStaleAgentToken(err)) {
        setDraft((value) => {
          const next = { ...value };
          delete next.agent;
          return next;
        });
        await getDb().kv.delete(AGENT_PENDING_KEY);
        setAgentError('agent_already_paired');
      } else setAgentError('agent_unreachable');
    } finally {
      setAgentBusy(false);
    }
  };

  const dotsFor = (chars: number) =>
    chars <= 24 ? 288 : chars <= 32 ? 384 : chars === 42 ? 512 : 576;

  const setChars = (chars: 48 | 42 | 32 | 24) =>
    patch({ chars_per_line: chars, dots: dotsFor(chars) });

  const paper = (mm: 58 | 80) => {
    if (mm === 58) {
      patch({ paper_mm: 58, chars_per_line: 32, dots: 384 });
      return;
    }
    const chars = draft.chars_per_line ?? 48;
    patch({ paper_mm: 80, chars_per_line: chars, dots: dotsFor(chars) });
  };

  const connectUsb = async (all: boolean) => {
    setError(null);
    try {
      const device = (await deps.usb?.requestDevice({
        filters: all ? [] : [{ classCode: 7 }],
      })) as UsbDeviceLike;
      patch({
        transport: 'usb',
        usb: {
          vendorId: device.vendorId,
          productId: device.productId,
          serialNumber: device.serialNumber ?? null,
          name: device.productName ?? undefined,
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'NotFoundError') setError(errorCode(err));
    }
  };

  const choosePort = async () => {
    setError(null);
    try {
      const port = (await deps.serial?.requestPort()) as SerialPortLike;
      const info = port.getInfo();
      patch({
        transport: 'serial',
        serial: {
          usbVendorId: info.usbVendorId,
          usbProductId: info.usbProductId,
          baudRate: serialChoice.baudRate,
          flowControl: serialChoice.flowControl,
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'NotFoundError') setError(errorCode(err));
    }
  };

  const connected = printerConnected(draft, agentHealth);

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      // A drawer kick is a separate permission-gated action (UI-M5): the wizard may be
      // open on a read-only/support device, or for a cashier without drawer.open.
      await printTestPage(getDb(), draft, deps, {
        drawer:
          can('drawer.open') && !readOnly && !support && draft.drawer !== false,
      });
      setTested(true);
    } catch (err) {
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!connected) return;
    try {
      const db = getDb();
      await setKv(db, 'printer', draft);
      // The token now lives in `kv.printer`; the recovery copy is no longer needed.
      await db.kv.delete(AGENT_PENDING_KEY);
      onDone();
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };

  return (
    <section
      aria-labelledby="wizard-title"
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4"
    >
      <h2 id="wizard-title" className="text-title font-semibold">
        {t('printer.wizard_title')}{' '}
        <span className="text-small text-text-muted">
          {t('printer.step', {
            n: step === 'paper' ? 1 : step === 'connection' ? 2 : 3,
            total: 3,
          })}
        </span>
      </h2>

      {step === 'paper' ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 font-medium">{t('printer.paper')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {([80, 58] as const).map((mm) => (
              <label key={mm} className={choice(draft.paper_mm === mm)}>
                <span className="flex items-center gap-2 font-medium">
                  <input
                    type="radio"
                    name="paper"
                    checked={draft.paper_mm === mm}
                    onChange={() => paper(mm)}
                  />
                  {t(mm === 80 ? 'printer.paper_80' : 'printer.paper_58')}
                </span>
                <span className="text-small text-text-muted">
                  {t('printer.paper_hint', {
                    chars: mm === 58 ? 32 : draft.chars_per_line,
                  })}
                </span>
              </label>
            ))}
          </div>
          {draft.paper_mm === 80 ? (
            <fieldset className="rounded-card border border-border bg-surface-2/40 p-3">
              <legend className="px-1 text-small font-medium">
                {t('printer.chars_per_line')}
              </legend>
              <div className="flex flex-wrap gap-2">
                {([48, 42, 32, 24] as const).map((chars) => (
                  <label
                    key={chars}
                    className={charsChoice(draft.chars_per_line === chars)}
                  >
                    <input
                      type="radio"
                      name="chars_per_line"
                      checked={draft.chars_per_line === chars}
                      onChange={() => setChars(chars)}
                    />
                    {t(
                      chars === 48
                        ? 'printer.chars_48'
                        : chars === 42
                          ? 'printer.chars_42'
                          : chars === 32
                            ? 'printer.chars_32'
                            : 'printer.chars_24',
                    )}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-small text-text-muted">
                {t('printer.chars_hint')}
              </p>
              {draft.chars_per_line === 32 || draft.chars_per_line === 24 ? (
                <p className="mt-1 text-small text-text-muted">
                  {t('printer.centered_hint', {
                    mm: Math.round((draft.dots ?? 384) / 8),
                  })}
                </p>
              ) : null}
            </fieldset>
          ) : (
            <p className="text-small text-text-muted">
              {t('printer.paper_58_hint')}
            </p>
          )}
        </fieldset>
      ) : null}

      {step === 'connection' ? (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-medium">
              {t('printer.connection')}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(['agent', 'usb', 'serial', 'system'] as const)
                .filter((tr) => tr !== 'agent' || desktop)
                .map((tr) => {
                  const supported =
                    tr === 'agent'
                      ? desktop
                      : tr === 'system' ||
                        (tr === 'usb' ? deps.usb : deps.serial) !== null;
                  return (
                    <label
                      key={tr}
                      className={`${choice(draft.transport === tr)} ${
                        tr === 'agent'
                          ? 'sm:col-span-2 lg:col-span-3'
                          : tr === 'system'
                            ? 'sm:col-span-2 lg:col-span-1'
                            : ''
                      } ${supported ? '' : 'opacity-60'}`}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <input
                          type="radio"
                          name="transport"
                          disabled={!supported}
                          checked={draft.transport === tr}
                          onChange={() => {
                            patch({ transport: tr });
                            if (tr === 'agent') void checkAgent();
                          }}
                        />
                        {t(`printer.transport_${tr}`)}
                      </span>
                      <span className="text-small text-text-muted">
                        {supported
                          ? t(`printer.transport_${tr}_hint`)
                          : t('printer.needs_chrome')}
                      </span>
                    </label>
                  );
                })}
            </div>
          </fieldset>
          {draft.transport === 'usb' && deps.usb ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={buttonPrimary}
                onClick={() => void connectUsb(false)}
              >
                {t('printer.connect_usb')}
              </button>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => void connectUsb(true)}
              >
                {t('printer.show_all_usb')}
              </button>
              {draft.usb ? (
                <span data-testid="printer-device">
                  {t('printer.connected_to', {
                    name:
                      draft.usb.name ??
                      `USB ${draft.usb.vendorId.toString(16)}:${draft.usb.productId.toString(16)}`,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
          {draft.transport === 'serial' && deps.serial ? (
            <div className="flex flex-wrap items-end gap-2">
              <button
                type="button"
                className={buttonPrimary}
                onClick={() => void choosePort()}
              >
                {t('printer.choose_port')}
              </button>
              <label className="flex flex-col gap-1">
                <span className="text-small">{t('printer.baud')}</span>
                <select
                  className="h-11 rounded-control border border-border-strong bg-surface px-2"
                  value={serialChoice.baudRate}
                  onChange={(e) =>
                    changeSerialChoice({
                      ...serialChoice,
                      baudRate: Number(e.target.value),
                    })
                  }
                >
                  {BAUDS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-small">{t('printer.flow_control')}</span>
                <select
                  className="h-11 rounded-control border border-border-strong bg-surface px-2"
                  value={serialChoice.flowControl}
                  onChange={(e) =>
                    changeSerialChoice({
                      ...serialChoice,
                      flowControl: e.target.value as 'none' | 'hardware',
                    })
                  }
                >
                  <option value="none">{t('printer.flow_none')}</option>
                  <option value="hardware">{t('printer.flow_hardware')}</option>
                </select>
              </label>
              {draft.serial ? (
                <span data-testid="printer-device">
                  {t('printer.port_chosen')}
                </span>
              ) : null}
            </div>
          ) : null}
          {draft.transport === 'agent' ? (
            <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-3">
              {agentChecking ? (
                <p className="text-small text-text-muted">
                  {t('printer.agent_checking')}
                </p>
              ) : agentHealth === null || !agentCompatible(agentHealth) ? (
                <>
                  <p className="text-small">
                    {t(
                      agentHealth === null
                        ? 'printer.agent_not_found'
                        : 'printer.agent_outdated',
                    )}
                  </p>
                  <p className="text-small font-medium">
                    {t('printer.agent_download')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {downloadKeys.map((key) => (
                      <a
                        key={key}
                        href={AGENT_DOWNLOADS[key]}
                        target="_blank"
                        rel="noreferrer"
                        className={
                          key === primaryDownload ? buttonPrimary : buttonQuiet
                        }
                      >
                        {t(`printer.agent_download_${key}`)}
                      </a>
                    ))}
                  </div>
                  <p className="text-small text-text-muted">
                    <a
                      href={AGENT_RELEASE_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {t('printer.agent_download_all')}
                    </a>
                    {' · '}
                    <a
                      href={AGENT_SHA256_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {t('printer.agent_download_sha')}
                    </a>
                  </p>
                  <p className="text-small text-text-muted">
                    {t('printer.agent_download_hint')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={buttonQuiet}
                      disabled={agentBusy}
                      onClick={() => void checkAgent()}
                    >
                      {t('printer.agent_check')}
                    </button>
                  </div>
                  <p className="text-small text-text-muted">
                    {t('printer.agent_help')}
                  </p>
                </>
              ) : agentHealth.paired === false ? (
                <>
                  <p className="text-small">{t('printer.agent_pair_hint')}</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-small">
                        {t('printer.agent_code')}
                      </span>
                      <input
                        className="h-11 w-32 rounded-control border border-border-strong bg-surface px-2 text-center font-mono text-title tracking-[0.2em]"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={agentCode}
                        onChange={(e) =>
                          setAgentCode(
                            normaliseNumericText(e.target.value).replace(
                              /\D/gu,
                              '',
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className={buttonPrimary}
                      disabled={
                        agentBusy ||
                        agentCode.trim().length !== 6 ||
                        !agentCompatible(agentHealth)
                      }
                      onClick={() => void pairAgent()}
                    >
                      {t('printer.agent_pair')}
                    </button>
                    {agentHealth.pairingCode ? null : (
                      <button
                        type="button"
                        className={buttonQuiet}
                        onClick={() =>
                          window.open(AGENT_URL, '_blank', 'noopener')
                        }
                      >
                        {t('printer.agent_open')}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={buttonQuiet}
                      disabled={agentBusy}
                      onClick={() => void checkAgent()}
                    >
                      {t('printer.agent_recheck')}
                    </button>
                  </div>
                  <p className="text-small text-text-muted">
                    {t('printer.agent_code_hint')}
                  </p>
                  <p className="text-small text-text-muted">
                    {t('printer.agent_version', {
                      version: agentHealth.version,
                    })}
                  </p>
                </>
              ) : draft.agent?.token ? (
                <>
                  <p className="text-small">
                    {t('printer.agent_paired')} ·{' '}
                    {t('printer.agent_version', {
                      version: agentHealth.version,
                    })}
                  </p>
                  <label className="flex flex-col gap-1">
                    <span className="text-small">
                      {t('printer.agent_printers')}
                    </span>
                    <select
                      data-testid="agent-printer"
                      className="h-11 rounded-control border border-border-strong bg-surface px-2"
                      value={draft.agent.printerName}
                      onChange={(e) =>
                        patchAgent({ printerName: e.target.value })
                      }
                    >
                      <option value="">
                        {t('printer.agent_select_printer')}
                      </option>
                      {agentPrinters.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.isDefault
                            ? ` · ${t('printer.agent_default')}`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {agentPrinters.length === 0 ? (
                    <p className="text-small text-text-muted">
                      {t('printer.agent_no_printers')}
                    </p>
                  ) : null}
                  <fieldset className="flex flex-col gap-2 sm:flex-row">
                    <legend className="mb-1 w-full font-medium">
                      {t('printer.agent_mode')}
                    </legend>
                    {(['raw', 'driver'] as const).map((mode) => (
                      <label
                        key={mode}
                        className={choice(draft.agent?.mode === mode)}
                      >
                        <span className="flex items-center gap-2 font-medium">
                          <input
                            type="radio"
                            name="agent-mode"
                            checked={draft.agent?.mode === mode}
                            onChange={() => patchAgent({ mode })}
                          />
                          {t(`printer.agent_mode_${mode}`)}
                        </span>
                        <span className="text-small text-text-muted">
                          {t(`printer.agent_mode_${mode}_hint`)}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {draft.agent.mode === 'driver' ? (
                    <p className="text-small text-text-muted">
                      {t('printer.agent_driver_warning')}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={buttonQuiet}
                      disabled={agentBusy}
                      onClick={() => void checkAgent()}
                    >
                      {t('printer.agent_recheck')}
                    </button>
                    <button
                      type="button"
                      className={buttonQuiet}
                      disabled={agentBusy}
                      onClick={() => void unpairAgent()}
                    >
                      {t('printer.agent_unpair')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-small">
                    {t('printer.agent_already_paired')}
                  </p>
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => window.open(AGENT_URL, '_blank', 'noopener')}
                  >
                    {t('printer.agent_open')}
                  </button>
                  <button
                    type="button"
                    className={buttonQuiet}
                    disabled={agentBusy}
                    onClick={() => void checkAgent()}
                  >
                    {t('printer.agent_recheck')}
                  </button>
                </>
              )}
              {agentError ? (
                <p className="text-small text-danger">
                  {t(`printer.${agentError}`)}
                </p>
              ) : null}
            </div>
          ) : null}
          {draft.transport === 'system' ? (
            <p className="text-small text-text-muted">
              {t('printer.system_help')}
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 'test' ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            className={`${buttonPrimary} self-start`}
            aria-busy={busy}
            disabled={busy}
            onClick={() => void test()}
          >
            {t('printer.test_print')}
          </button>
          {tested ? (
            <>
              <p role="status">{t('printer.test_sent')}</p>
              <YesNo
                label={t('printer.q_ruler')}
                value={ruler}
                onChange={setRuler}
              />
              {ruler === 'no' ? (
                <div className="flex flex-wrap gap-2">
                  {draft.paper_mm === 80 && draft.chars_per_line !== 24 ? (
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        setChars(24);
                        setTested(false);
                        setRuler(null);
                      }}
                    >
                      {t('printer.use_24')}
                    </button>
                  ) : null}
                  {draft.paper_mm === 80 && draft.chars_per_line !== 32 ? (
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        setChars(32);
                        setTested(false);
                        setRuler(null);
                      }}
                    >
                      {t('printer.use_32')}
                    </button>
                  ) : null}
                  {draft.paper_mm === 80 && draft.chars_per_line !== 42 ? (
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        setChars(42);
                        setTested(false);
                        setRuler(null);
                      }}
                    >
                      {t('printer.use_42')}
                    </button>
                  ) : null}
                  {draft.paper_mm !== 58 ? (
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        paper(58);
                        setTested(false);
                        setRuler(null);
                      }}
                    >
                      {t('printer.use_58')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <YesNo
                label={t('printer.q_urdu')}
                value={urdu}
                onChange={setUrdu}
              />
              {urdu === 'no' ? (
                <p className="text-small text-text-muted">
                  {t('printer.urdu_no')}
                </p>
              ) : null}
              <YesNo label={t('printer.q_cut')} value={cut} onChange={setCut} />
              {cut === 'no' ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => patch({ cut: 'none' })}
                  >
                    {t('printer.set_cut_none')}
                  </button>
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() =>
                      patch({ drawer_pin: draft.drawer_pin === 5 ? 2 : 5 })
                    }
                  >
                    {t('printer.swap_pin', {
                      pin: draft.drawer_pin === 5 ? 2 : 5,
                    })}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-card bg-danger-subtle p-3 text-danger-subtle-ink"
        >
          <p>{t(`print.err_${error}`)}</p>
          {error === 'PERMISSION' ? (
            <p className="text-small">{t('printer.driver_help')}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2">
        <button
          type="button"
          className={buttonQuiet}
          onClick={() =>
            step === 'paper'
              ? onDone()
              : setStep(step === 'test' ? 'connection' : 'paper')
          }
        >
          {step === 'paper' ? t('common.cancel') : t('printer.back')}
        </button>
        {step === 'test' ? (
          <button
            type="button"
            className={buttonPrimary}
            disabled={!connected}
            onClick={() => void save()}
          >
            {t('printer.save')}
          </button>
        ) : (
          <button
            type="button"
            className={buttonPrimary}
            disabled={step === 'connection' && !connected}
            onClick={() => {
              if (step === 'paper' && !draft.chars_per_line) setChars(48);
              setStep(step === 'paper' ? 'connection' : 'test');
            }}
          >
            {t('printer.next')}
          </button>
        )}
      </div>
    </section>
  );
}
