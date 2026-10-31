import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    <Box
      component="fieldset"
      aria-labelledby={id}
      style={{ border: 0, margin: 0, padding: 0 }}
    >
      <Text component="legend" fw={500} mb="xs" id={id}>
        {label}
      </Text>
      <Radio.Group value={value} onChange={(next) => onChange(next as Answer)}>
        <Group gap="sm">
          {(['yes', 'no'] as const).map((a) => (
            <Radio
              key={a}
              value={a}
              label={t(a === 'yes' ? 'common.yes' : 'common.no')}
            />
          ))}
        </Group>
      </Radio.Group>
    </Box>
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
    <Paper withBorder p="lg" component="section" aria-labelledby="wizard-title">
      <Stack gap="md">
        <Group gap="sm" align="baseline">
          <Title order={2} fz="lg" id="wizard-title">
            {t('printer.wizard_title')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('printer.step', {
              n: step === 'paper' ? 1 : step === 'connection' ? 2 : 3,
              total: 3,
            })}
          </Text>
        </Group>

        {step === 'paper' ? (
          <Radio.Group
            label={t('printer.paper')}
            value={String(draft.paper_mm)}
            onChange={(value) => paper(Number(value) as 58 | 80)}
          >
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" mt="xs">
              {([80, 58] as const).map((mm) => (
                <Paper key={mm} withBorder p="sm" radius="md">
                  <Radio
                    value={String(mm)}
                    label={t(
                      mm === 80 ? 'printer.paper_80' : 'printer.paper_58',
                    )}
                    description={t('printer.paper_hint', {
                      chars: mm === 80 ? 48 : 32,
                    })}
                  />
                </Paper>
              ))}
            </SimpleGrid>
          </Radio.Group>
        ) : null}

        {step === 'connection' ? (
          <Stack gap="md">
            <Radio.Group
              label={t('printer.connection')}
              value={draft.transport}
              onChange={(value) =>
                patch({ transport: value as PrinterKv['transport'] })
              }
            >
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm" mt="xs">
                {(['usb', 'serial', 'system'] as const).map((tr) => {
                  const supported =
                    tr === 'system' ||
                    (tr === 'usb' ? deps.usb : deps.serial) !== null;
                  return (
                    <Paper
                      key={tr}
                      withBorder
                      p="sm"
                      radius="md"
                      opacity={supported ? undefined : 0.6}
                    >
                      <Radio
                        value={tr}
                        disabled={!supported}
                        label={t(`printer.transport_${tr}`)}
                        description={
                          supported
                            ? t(`printer.transport_${tr}_hint`)
                            : t('printer.needs_chrome')
                        }
                      />
                    </Paper>
                  );
                })}
              </SimpleGrid>
            </Radio.Group>
            {draft.transport === 'usb' ? (
              <Group gap="sm" align="center">
                <Button type="button" onClick={() => void connectUsb(false)}>
                  {t('printer.connect_usb')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  onClick={() => void connectUsb(true)}
                >
                  {t('printer.show_all_usb')}
                </Button>
                {draft.usb ? (
                  <Text size="sm" data-testid="printer-device">
                    {t('printer.connected_to', {
                      name:
                        draft.usb.name ??
                        `USB ${draft.usb.vendorId.toString(16)}:${draft.usb.productId.toString(16)}`,
                    })}
                  </Text>
                ) : null}
              </Group>
            ) : null}
            {draft.transport === 'serial' ? (
              <Group gap="sm" align="flex-end">
                <Button type="button" onClick={() => void choosePort()}>
                  {t('printer.choose_port')}
                </Button>
                <NativeSelect
                  label={t('printer.baud')}
                  value={draft.serial?.baudRate ?? 9600}
                  onChange={(event) =>
                    patch({
                      serial: {
                        flowControl: 'none',
                        ...draft.serial,
                        baudRate: Number(event.currentTarget.value),
                      },
                    })
                  }
                  data={BAUDS.map((b) => ({
                    value: String(b),
                    label: String(b),
                  }))}
                  w={140}
                />
                {draft.serial ? (
                  <Text size="sm" data-testid="printer-device" mb={10}>
                    {t('printer.port_chosen')}
                  </Text>
                ) : null}
              </Group>
            ) : null}
            {draft.transport === 'system' ? (
              <Text size="sm" c="dimmed">
                {t('printer.system_help')}
              </Text>
            ) : null}
          </Stack>
        ) : null}

        {step === 'test' ? (
          <Stack gap="md">
            <Button
              type="button"
              aria-busy={busy}
              disabled={busy}
              loading={busy}
              onClick={() => void test()}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('printer.test_print')}
            </Button>
            {tested ? (
              <>
                <Text size="sm" role="status">
                  {t('printer.test_sent')}
                </Text>
                <YesNo
                  label={t('printer.q_ruler')}
                  value={ruler}
                  onChange={setRuler}
                />
                {ruler === 'no' ? (
                  <Group gap="sm">
                    {draft.paper_mm === 80 && draft.chars_per_line !== 42 ? (
                      <Button
                        type="button"
                        variant="default"
                        onClick={() => {
                          paper(80, true);
                          setTested(false);
                          setRuler(null);
                        }}
                      >
                        {t('printer.use_42')}
                      </Button>
                    ) : null}
                    {draft.paper_mm !== 58 ? (
                      <Button
                        type="button"
                        variant="default"
                        onClick={() => {
                          paper(58);
                          setTested(false);
                          setRuler(null);
                        }}
                      >
                        {t('printer.use_58')}
                      </Button>
                    ) : null}
                  </Group>
                ) : null}
                <YesNo
                  label={t('printer.q_urdu')}
                  value={urdu}
                  onChange={setUrdu}
                />
                {urdu === 'no' ? (
                  <Text size="sm" c="dimmed">
                    {t('printer.urdu_no')}
                  </Text>
                ) : null}
                <YesNo
                  label={t('printer.q_cut')}
                  value={cut}
                  onChange={setCut}
                />
                {cut === 'no' ? (
                  <Group gap="sm">
                    <Button
                      type="button"
                      variant="default"
                      onClick={() => patch({ cut: 'none' })}
                    >
                      {t('printer.set_cut_none')}
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      onClick={() =>
                        patch({ drawer_pin: draft.drawer_pin === 5 ? 2 : 5 })
                      }
                    >
                      {t('printer.swap_pin', {
                        pin: draft.drawer_pin === 5 ? 2 : 5,
                      })}
                    </Button>
                  </Group>
                ) : null}
              </>
            ) : null}
          </Stack>
        ) : null}

        {error ? (
          <Paper p="sm" role="alert" bg="var(--mantine-color-danger-subtle)">
            <Text size="sm" c="var(--mantine-color-danger-subtle-ink)">
              {t(`print.err_${error}`)}
            </Text>
            {error === 'PERMISSION' ? (
              <Text size="sm" c="var(--mantine-color-danger-subtle-ink)">
                {t('printer.driver_help')}
              </Text>
            ) : null}
          </Paper>
        ) : null}

        <Group justify="space-between" gap="sm">
          <Button
            type="button"
            variant="default"
            onClick={() =>
              step === 'paper'
                ? onDone()
                : setStep(step === 'test' ? 'connection' : 'paper')
            }
          >
            {step === 'paper' ? t('common.cancel') : t('printer.back')}
          </Button>
          {step === 'test' ? (
            <Button type="button" onClick={() => void save()}>
              {t('printer.save')}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={step === 'connection' && !connected}
              onClick={() => {
                if (step === 'paper' && !draft.chars_per_line)
                  paper(draft.paper_mm ?? 80);
                setStep(step === 'paper' ? 'connection' : 'test');
              }}
            >
              {t('printer.next')}
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}
