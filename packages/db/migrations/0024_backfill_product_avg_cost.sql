-- Products created with a catalogue cost but no stock movement kept `avg_cost = 0` on
-- the server (the column is server-managed and was only derived from movements). That
-- made a sale before the first costed movement look like a zero-cost sale after a pull.
-- Initialise those rows from the catalogue cost; rows with movements keep their derived
-- weighted average. Additive data repair only: no column or wire change.
UPDATE products
SET avg_cost = last_cost
WHERE avg_cost = 0
  AND last_cost > 0
  AND NOT EXISTS (
    SELECT 1
    FROM stock_movements sm
    WHERE sm.tenant_id = products.tenant_id
      AND sm.product_id = products.id
  );
