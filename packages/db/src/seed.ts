/** Expense category templates (02 §2.1 seed); copied into each shop as `expense_categories`. */
export const EXPENSE_CATEGORY_TEMPLATES = [
  {
    code: 'electricity',
    name_en: 'Electricity',
    name_ur: 'بجلی',
    icon: 'bolt',
    sort_order: 1,
  },
  {
    code: 'tea_snacks',
    name_en: 'Tea & snacks',
    name_ur: 'چائے پانی',
    icon: 'cup',
    sort_order: 2,
  },
  {
    code: 'transport',
    name_en: 'Transport',
    name_ur: 'کرایہ',
    icon: 'truck',
    sort_order: 3,
  },
  {
    code: 'salary',
    name_en: 'Salary',
    name_ur: 'تنخواہ',
    icon: 'users',
    sort_order: 4,
  },
  {
    code: 'rent',
    name_en: 'Rent',
    name_ur: 'کرایہ دکان',
    icon: 'home',
    sort_order: 5,
  },
  {
    code: 'repairs',
    name_en: 'Repairs',
    name_ur: 'مرمت',
    icon: 'wrench',
    sort_order: 6,
  },
  {
    code: 'internet_phone',
    name_en: 'Internet & phone',
    name_ur: 'انٹرنیٹ و فون',
    icon: 'wifi',
    sort_order: 7,
  },
  {
    code: 'other',
    name_en: 'Other',
    name_ur: 'دیگر',
    icon: 'dots',
    sort_order: 99,
  },
] as const;
