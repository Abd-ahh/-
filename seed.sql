-- Default subscription packages
INSERT OR IGNORE INTO packages (id, name_ar, name_en, max_numbers, monthly_operations, price, currency, sort_order) VALUES
  (1, 'باقة بداية', 'Starter', 1, 500, 199, 'SAR', 1),
  (2, 'باقة احترافية', 'Professional', 3, 2000, 499, 'SAR', 2),
  (3, 'باقة شركات', 'Enterprise', 10, 10000, 1499, 'SAR', 3);
