import { Box, Text } from '@mantine/core';

/** The Bikri monogram: navy tile, teal letter, subtle inner highlight. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <Box
      aria-hidden="true"
      w={size}
      h={size}
      style={{
        display: 'grid',
        placeItems: 'center',
        borderRadius: 10,
        background: 'linear-gradient(135deg, #1b355d 0%, #0b1a33 100%)',
        boxShadow:
          'inset 0 1px 0 rgb(255 255 255 / 0.14), 0 1px 2px rgb(15 23 42 / 0.18)',
      }}
    >
      <Text
        fw={800}
        fz={size * 0.5}
        lh={1}
        style={{ color: '#5fdcd7', letterSpacing: '-0.04em' }}
      >
        B
      </Text>
    </Box>
  );
}
