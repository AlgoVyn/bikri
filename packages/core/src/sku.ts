const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 02 products.sku: 3 letters of the name + '-' + 4 base32 chars, e.g. `SAM-7K2Q`. */
export function generateSku(
  name: string,
  random: () => number = Math.random,
): string {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3)
    .padEnd(3, 'X');
  let tail = '';
  for (let i = 0; i < 4; i += 1) tail += BASE32[Math.floor(random() * 32) % 32];
  return `${letters}-${tail}`;
}
