import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { getDb } from '../data/db.ts';
import { setKv } from '../data/kv.ts';
import type { PrinterKv } from '../data/receipt.ts';
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
  const patch = (p: Partial<PrinterKv>) => setDraft((d) => ({ ...d, ...p }));

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
    (draft.transport === 'serial' && Boolean(draft.serial));

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
        </fieldset>
      ) : null}

      {step === 'connection' ? (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2 sm:flex-row">
            <legend className="mb-2 font-medium">
              {t('printer.connection')}
            </legend>
            {(['usb', 'serial', 'system'] as const).map((tr) => {
              const supported =
                tr === 'system' ||
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
                      onChange={() => patch({ transport: tr })}
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
