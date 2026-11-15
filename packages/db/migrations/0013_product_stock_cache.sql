-- Performance: server-side stock cache for push lookups (D-225). Additive only.
--
-- applyOps fills a CostState per referenced product on every push. It used to compute
-- on_hand by summing the product's entire stock_movements history and cost_changed_at by
-- scanning it again; both grow with the shop's age. These two columns are a server-only
-- cache, updated atomically with each movement and never pulled by tills.
ALTER TABLE products ADD COLUMN on_hand_milli INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN cost_changed_at INTEGER NOT NULL DEFAULT 0;
UPDATE products
SET
  on_hand_milli = COALESCE((
    SELECT SUM(m.qty_delta_milli)
    FROM stock_movements m
    WHERE m.tenant_id = products.tenant_id AND m.product_id = products.id
  ), 0),
  cost_changed_at = COALESCE((
    SELECT MAX(m.created_at)
    FROM stock_movements m
    WHERE m.tenant_id = products.tenant_id AND m.product_id = products.id
      AND m.qty_delta_milli > 0 AND m.unit_cost IS NOT NULL
  ), 0);

-- Keep the cache correct for every insert path, including operator imports and tests
-- that write stock_movements directly. The app still computes avg_cost/last_cost in the
-- same batch; this trigger only touches the two derived columns and never bumps rev.
CREATE TRIGGER products_stock_after_movement
AFTER INSERT ON stock_movements
BEGIN
  UPDATE products
  SET
    on_hand_milli = on_hand_milli + NEW.qty_delta_milli,
    cost_changed_at = CASE
      WHEN NEW.qty_delta_milli > 0 AND NEW.unit_cost IS NOT NULL
        THEN MAX(cost_changed_at, NEW.created_at)
      ELSE cost_changed_at
    END
  WHERE tenant_id = NEW.tenant_id AND id = NEW.product_id;
END;
