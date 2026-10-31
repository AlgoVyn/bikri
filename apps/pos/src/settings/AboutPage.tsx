import { APP_VERSION } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { InfoIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { useToast } from '../components/Toast.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
import { SettingsPageLayout } from './Layout.tsx';

/** About, version and the terms/privacy notes (screens/17, 09 §6.1). */
export function AboutPage() {
  return (
    <AreaStrings area="office">
      <AboutContent />
    </AreaStrings>
  );
}

function AboutContent() {
  const { t } = useTranslation();
  const toast = useToast();
  const check = async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) {
        await registration.update();
        toast.push(t('office.about.updated'));
      } else {
        window.location.reload();
      }
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  return (
    <SettingsPageLayout title={t('office.about.title')} icon={<InfoIcon />}>
      <Stack gap="sm">
        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Group gap={6}>
              <Text size="sm" c="dimmed">
                {t('office.about.version')}:
              </Text>
              <Text size="sm" ff="monospace" component="bdi" dir="ltr">
                {APP_VERSION}
              </Text>
            </Group>
            <Text size="sm" c="dimmed">
              {t('office.about.built_note')}
            </Text>
            <Group gap="sm">
              <Button
                component="a"
                href="https://github.com/AlgoVyn/bikri"
                target="_blank"
                rel="noreferrer"
                variant="default"
              >
                {t('office.about.source')}
              </Button>
              <Button
                component="a"
                href="https://github.com/AlgoVyn/bikri/blob/main/LICENSE"
                target="_blank"
                rel="noreferrer"
                variant="default"
              >
                {t('office.about.license')}
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={() => void check()}
              >
                {t('office.about.check_update')}
              </Button>
            </Group>
          </Stack>
        </Paper>

        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={2} fz="lg">
              {t('office.about.shortcuts')}
            </Title>
            <Text size="sm" c="dimmed">
              {t('office.about.shortcuts_hint')}
            </Text>
            {[
              {
                title: t('office.about.shortcuts_global'),
                rows: [
                  ['/', t('shell.search_label')],
                  ['N', t('home.new_sale')],
                  ['Ctrl+Shift+P', t('home.price_check')],
                  ['Ctrl+Shift+1…9', t('office.about.shortcuts_rail')],
                  ['Ctrl+L', t('shell.lock')],
                ],
              },
              {
                title: t('office.about.shortcuts_sell'),
                rows: [
                  ['F2', t('sell.search_label')],
                  ['Ctrl+1/2/3', t('sell.carts')],
                  ['F3', t('sell.add_discount')],
                  ['F4', t('sell.hold')],
                  ['F6', t('sell.held_title')],
                  ['F7', t('sell.quick_sale')],
                  ['F8', t('sell.take_payment')],
                  ['1–4', t('pay.method')],
                  ['F9', t('printer.open_drawer')],
                ],
              },
              {
                title: t('office.about.shortcuts_details'),
                rows: [
                  ['Ctrl+S', t('form.save')],
                  ['Esc', t('common.close')],
                  ['P', t('office.bill.print')],
                  ['R', t('office.bill.refund')],
                  ['L', t('products.print_label')],
                ],
              },
            ].map((group) => (
              <Box key={group.title}>
                <Text fw={500} mb={4}>
                  {group.title}
                </Text>
                <Table fz="sm">
                  <Table.Tbody>
                    {group.rows.map(([keys = '', label = '']) => (
                      <Table.Tr key={`${group.title}:${keys}`}>
                        <Table.Td w={160} style={{ verticalAlign: 'top' }}>
                          <KeyBadge keys={keys} always />
                        </Table.Td>
                        <Table.Td>{label}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Box>
            ))}
          </Stack>
        </Paper>

        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={2} fz="lg">
              {t('office.about.terms')}
            </Title>
            <Box component="ol" ps="md" my={0}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((number) => (
                <Text component="li" key={number} size="sm">
                  {t(`office.about.terms_${number}`)}
                </Text>
              ))}
            </Box>
          </Stack>
        </Paper>

        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={2} fz="lg">
              {t('office.about.privacy')}
            </Title>
            <Text size="sm" c="dimmed">
              {t('office.about.privacy_note')}
            </Text>
          </Stack>
        </Paper>
      </Stack>
    </SettingsPageLayout>
  );
}
