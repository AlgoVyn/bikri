import {
  ActionIcon,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProductsIcon } from '../components/icons.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  addCategory,
  CATEGORY_COLORS,
  CategoryInUseError,
  listCategories,
  moveCategory,
  removeCategory,
  updateCategory,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { tileBg } from './tiles.ts';

/** Categories (screens/08): add, rename, colour, reorder, delete when empty. */
export function CategoriesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can, staff } = useCurrentStaff();
  const readOnly = useReadOnly();
  const categories = useLiveQuery(() => listCategories(getDb()), []);
  const [name, setName] = useState('');
  const [nameUr, setNameUr] = useState('');
  if (!can('catalog.edit') || readOnly)
    return <Navigate to="/products" replace />;

  return (
    <Box mx="auto" maw={672} p="md" w="100%">
      <Stack gap="md">
        <SubpageHeader
          backTo="/products"
          backLabel={t('import.back_to_products')}
          icon={<ProductsIcon />}
          title={t('categories.title')}
        />
        <Paper withBorder p="sm">
          <Box
            component="form"
            onSubmit={async (event: React.FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!name.trim()) return;
              await addCategory(
                getDb(),
                name,
                CATEGORY_COLORS[
                  (categories?.length ?? 0) % CATEGORY_COLORS.length
                ],
                { actor: staff?.id ?? null },
                nameUr,
              );
              setName('');
              setNameUr('');
            }}
          >
            <Stack gap="sm">
              <TextInput
                id="new-category"
                label={t('categories.new')}
                placeholder={t('categories.new')}
                maxLength={40}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <TextInput
                label={t('categories.name_ur')}
                placeholder={t('categories.name_ur')}
                aria-label={t('categories.name_ur')}
                lang="ur"
                dir="rtl"
                maxLength={40}
                value={nameUr}
                onChange={(event) => setNameUr(event.currentTarget.value)}
              />
              <Button
                type="submit"
                disabled={!name.trim()}
                style={{ alignSelf: 'flex-end' }}
              >
                {t('form.add')}
              </Button>
            </Stack>
          </Box>
        </Paper>
        {categories && categories.length === 0 ? (
          <Paper
            withBorder
            p="xl"
            style={{ borderStyle: 'dashed', background: 'transparent' }}
          >
            <Text c="dimmed" ta="center">
              {t('categories.empty')}
            </Text>
          </Paper>
        ) : null}
        <Stack gap="sm">
          {categories?.map((c, i) => {
            const label = String(c.name_en);
            return (
              <Paper key={c.id} withBorder p="sm">
                <Stack gap="sm">
                  <Group align="flex-start" gap="sm" wrap="nowrap">
                    <Box
                      aria-hidden="true"
                      w={24}
                      h={24}
                      mt={6}
                      style={{ borderRadius: 999 }}
                      className={tileBg(c.color)}
                    />
                    <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                      <TextInput
                        aria-label={t('categories.name', { name: label })}
                        maxLength={40}
                        defaultValue={label}
                        onBlur={(event) => {
                          const next = event.currentTarget.value.trim();
                          if (next && next !== label)
                            void updateCategory(
                              getDb(),
                              c.id,
                              { name_en: next },
                              { actor: staff?.id ?? null },
                            );
                          else event.currentTarget.value = label;
                        }}
                      />
                      <TextInput
                        aria-label={t('categories.name_ur')}
                        lang="ur"
                        dir="rtl"
                        maxLength={40}
                        placeholder={t('categories.name_ur')}
                        defaultValue={String(c.name_ur ?? '')}
                        onBlur={(event) => {
                          const next = event.currentTarget.value.trim();
                          if (next !== String(c.name_ur ?? ''))
                            void updateCategory(
                              getDb(),
                              c.id,
                              { name_ur: next },
                              { actor: staff?.id ?? null },
                            );
                        }}
                      />
                    </Stack>
                    <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {t('categories.products', { count: c.productCount })}
                    </Text>
                  </Group>
                  <Group justify="space-between" gap="sm" wrap="wrap">
                    <Box
                      component="fieldset"
                      style={{ border: 0, margin: 0, padding: 0 }}
                    >
                      <Text component="legend" className="sr-only">
                        {t('categories.color', { name: label })}
                      </Text>
                      <Group gap={0}>
                        {CATEGORY_COLORS.map((color, n) => (
                          <Box
                            key={color}
                            component="label"
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 44,
                              height: 44,
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="radio"
                              name={`color-${c.id}`}
                              className="sr-only"
                              checked={c.color === color}
                              onChange={() =>
                                void updateCategory(
                                  getDb(),
                                  c.id,
                                  { color },
                                  { actor: staff?.id ?? null },
                                )
                              }
                            />
                            <span className="sr-only">
                              {t('categories.color_n', { n: n + 1 })}
                            </span>
                            <Box
                              aria-hidden="true"
                              w={28}
                              h={28}
                              style={{
                                borderRadius: 999,
                                outline:
                                  c.color === color
                                    ? '2px solid var(--mantine-color-text)'
                                    : undefined,
                                outlineOffset: 2,
                              }}
                              className={tileBg(color)}
                            />
                          </Box>
                        ))}
                      </Group>
                    </Box>
                    <Group gap={4} ms="auto">
                      <ActionIcon
                        variant="default"
                        size={44}
                        disabled={i === 0}
                        aria-label={t('categories.up', { name: label })}
                        onClick={() =>
                          void moveCategory(getDb(), c.id, -1, {
                            actor: staff?.id ?? null,
                          })
                        }
                      >
                        ↑
                      </ActionIcon>
                      <ActionIcon
                        variant="default"
                        size={44}
                        disabled={i === (categories?.length ?? 0) - 1}
                        aria-label={t('categories.down', { name: label })}
                        onClick={() =>
                          void moveCategory(getDb(), c.id, 1, {
                            actor: staff?.id ?? null,
                          })
                        }
                      >
                        ↓
                      </ActionIcon>
                      <ActionIcon
                        variant="default"
                        size={44}
                        aria-label={t('categories.delete', { name: label })}
                        onClick={async () => {
                          try {
                            await removeCategory(getDb(), c.id, {
                              actor: staff?.id ?? null,
                            });
                          } catch (error) {
                            if (error instanceof CategoryInUseError) {
                              toast.push(
                                t('categories.in_use', { count: error.count }),
                                'error',
                              );
                            } else throw error;
                          }
                        }}
                      >
                        ×
                      </ActionIcon>
                    </Group>
                  </Group>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </Stack>
    </Box>
  );
}
