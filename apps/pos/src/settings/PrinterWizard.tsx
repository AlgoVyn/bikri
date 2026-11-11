import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { getDb } from '../data/db.ts';
import { setKv } from '../data/kv.ts';
import type { PrinterKv } from '../data/receipt.ts';
import {
  AGENT_DOWNLOAD_URL,
  AGENT_URL,
  type AgentHealth,
  type AgentMode,
  type AgentPrinter,
  AgentRequestError,
  httpAgentClient,
} from '../print/agent.ts';
import { browserPrintDeps } from '../print/printDeps.ts';
import { errorCode, printTestPage } from '../print/printService.ts';
import type {
  PrintErrorCode,
  SerialPortLike,
  UsbDeviceLike,
} from '../print/transports.ts';

type Step = 'paper' | 'connection' | 'test';
type Answer = 'yes' | 'no' | null;
const BAUDS = [9600, 19200, 38400, 115200] as const;

const choice = (on: boolean) =>
  `flex min-h-14 flex-1 flex-col items-start justify-center rounded-card border-2 p-3 text-start ${on ? 'border-primary bg-primary-subtle' : 'border-border bg-surface'}`;

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
  const deps = browserPrintDeps();
  const agent = deps.agent ?? httpAgentClient;
  const desktop =
    typeof navigator === 'undefined' ||
    !/Mobi|Android/iu.test(navigator.userAgent);
  const [step, setStep] = useState<Step>('paper');
  const [draft, setDraft] = useState<PrinterKv>(() => ({
    auto_print: true,
    copies: 1,
    print_logo: true,
    qr: false,
    drawer: true,
    drawer_pin: 2,
    cut: 'partial',
    ...current,
    paper_mm: current?.paper_mm ?? 80,
    transport:
      current?.transport ??
      (deps.usb ? 'usb' : deps.serial ? 'serial' : 'system'),
  }));
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
  const patch = (p: Partial<PrinterKv>) => setDraft((d) => ({ ...d, ...p }));
  const patchAgent = (p: Partial<NonNullable<PrinterKv['agent']>>) =>
    setDraft((d) =>
      d.agent === undefined ? d : { ...d, agent: { ...d.agent, ...p } },
    );

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const health = await agent.health(current?.agent?.url ?? AGENT_URL);
        if (cancelled) return;
        setAgentHealth(health);
        if (!health.paired && health.pairingCode)
          setAgentCode(health.pairingCode);
        if (health.paired && current?.agent?.token) {
          const list = await agent.printers(
            current.agent.url,
            current.agent.token,
          );
          if (!cancelled) setAgentPrinters(list);
        }
      } catch {
        if (!cancelled) setAgentHealth(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent, current, desktop]);

  const checkAgent = async () => {
    setAgentBusy(true);
    setAgentError(null);
    try {
      const url = draft.agent?.url ?? AGENT_URL;
      const health = await agent.health(url);
      setAgentHealth(health);
      if (!health.paired && health.pairingCode)
        setAgentCode(health.pairingCode);
      if (health.paired) {
        if (draft.agent?.token) {
          const list = await agent.printers(draft.agent.url, draft.agent.token);
          setAgentPrinters(list);
        } else {
          setAgentError('agent_already_paired');
        }
      }
    } catch {
      setAgentHealth(null);
      setAgentError('agent_unreachable');
    } finally {
      setAgentBusy(false);
    }
  };

  const pairAgent = async () => {
    setAgentBusy(true);
    setAgentError(null);
    try {
      const code = agentCode.trim() || agentHealth?.pairingCode || '';
      if (code.length !== 6) {
        setAgentError('agent_pair_failed');
        return;
      }
      const paired = await agent.pair(AGENT_URL, code, 'Bikri');
      const config = {
        url: AGENT_URL,
        token: paired.token,
        agentId: paired.agentId,
        printerName: '',
        mode: 'raw' as AgentMode,
      };
      patch({ transport: 'agent', agent: config });
      const list = await agent.printers(AGENT_URL, paired.token);
      setAgentPrinters(list);
      const chosen = list.find((p) => p.isDefault) ?? list[0];
      if (chosen) patch({ agent: { ...config, printerName: chosen.name } });
      setAgentHealth((health) =>
        health === null ? health : { ...health, paired: true },
      );
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
      const health = await agent.health(config.url);
      setAgentHealth(health);
      setAgentPrinters([]);
      setAgentCode(health.pairingCode ?? '');
      setDraft((currentDraft) => {
        const next = { ...currentDraft };
        delete next.agent;
        return next;
      });
    } catch {
      setAgentError('agent_unreachable');
    } finally {
      setAgentBusy(false);
    }
  };

  const paper = (mm: 58 | 80, wide = false) =>
    patch({
      paper_mm: mm,
      chars_per_line: mm === 58 ? 32 : wide ? 42 : 48,
      dots: mm === 58 ? 384 : wide ? 512 : 576,
    });

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
          baudRate: draft.serial?.baudRate ?? 9600,
          flowControl: draft.serial?.flowControl ?? 'none',
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'NotFoundError') setError(errorCode(err));
    }
  };

  const connected =
    draft.transport === 'system' ||
    (draft.transport === 'usb' && Boolean(draft.usb)) ||
    (draft.transport === 'serial' && Boolean(draft.serial)) ||
    (draft.transport === 'agent' &&
      Boolean(draft.agent?.token && draft.agent.printerName));

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      await printTestPage(getDb(), draft, deps);
      setTested(true);
    } catch (err) {
      setError(errorCode(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    await setKv(getDb(), 'printer', draft);
    onDone();
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
        <fieldset className="flex flex-col gap-2 sm:flex-row">
          <legend className="mb-2 font-medium">{t('printer.paper')}</legend>
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
                {t('printer.paper_hint', { chars: mm === 80 ? 48 : 32 })}
              </span>
            </label>
          ))}
          {draft.paper_mm === 80 && draft.chars_per_line !== 42 ? (
            <button
              type="button"
              className={`${buttonQuiet} self-center`}
              onClick={() => paper(80, true)}
            >
              {t('printer.use_42')}
            </button>
          ) : null}
        </fieldset>
      ) : null}

      {step === 'connection' ? (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2 sm:flex-row">
            <legend className="mb-2 font-medium">
              {t('printer.connection')}
            </legend>
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
                    className={`${choice(draft.transport === tr)} ${supported ? '' : 'opacity-60'}`}
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
          </fieldset>
          {draft.transport === 'usb' ? (
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
          {draft.transport === 'serial' ? (
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
                  value={draft.serial?.baudRate ?? 9600}
                  onChange={(e) =>
                    patch({
                      serial: {
                        flowControl: 'none',
                        ...draft.serial,
                        baudRate: Number(e.target.value),
                      },
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
              {draft.serial ? (
                <span data-testid="printer-device">
                  {t('printer.port_chosen')}
                </span>
              ) : null}
            </div>
          ) : null}
          {draft.transport === 'agent' ? (
            <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-3">
              {agentHealth === null ? (
                <>
                  <p className="text-small">{t('printer.agent_not_found')}</p>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={AGENT_DOWNLOAD_URL}
                      target="_blank"
                      rel="noreferrer"
                      className={buttonPrimary}
                    >
                      {t('printer.agent_download')}
                    </a>
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
                          setAgentCode(e.target.value.replace(/\D/gu, ''))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className={buttonPrimary}
                      disabled={agentBusy || agentCode.trim().length !== 6}
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
                      onClick={() =>
                        window.open(
                          draft.agent?.url ?? AGENT_URL,
                          '_blank',
                          'noopener',
                        )
                      }
                    >
                      {t('printer.agent_open')}
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
                  {draft.paper_mm === 80 && draft.chars_per_line !== 42 ? (
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        paper(80, true);
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
              if (step === 'paper' && !draft.chars_per_line)
                paper(draft.paper_mm ?? 80);
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
