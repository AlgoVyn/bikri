-- Verifier and time-zone guards (review hardening).
--
-- A malformed staff verifier (empty salt, zero PBKDF2 iterations) used to make every
-- PIN unlock throw on every till of the shop, and an unknown `shop.timezone` made
-- `Intl.DateTimeFormat` throw inside the sale write. The app now treats a bad verifier as
-- a wrong PIN and falls back to the documented time zone, and the push/import paths
-- validate both. These triggers keep a server-owned row from ever storing a value that
-- the tills cannot use, including through an operator import.
CREATE TRIGGER staff_pin_shape_insert
BEFORE INSERT ON staff
WHEN NEW.pin_iterations < 100000
  OR NEW.pin_iterations > 1000000
  OR length(NEW.pin_salt) < 16
  OR length(NEW.pin_salt) > 200
  OR length(NEW.pin_hash) < 16
  OR length(NEW.pin_hash) > 200
BEGIN
  SELECT RAISE(ABORT, 'staff pin verifier is malformed');
END;

CREATE TRIGGER staff_pin_shape_update
BEFORE UPDATE OF pin_hash, pin_salt, pin_iterations ON staff
WHEN NEW.pin_iterations < 100000
  OR NEW.pin_iterations > 1000000
  OR length(NEW.pin_salt) < 16
  OR length(NEW.pin_salt) > 200
  OR length(NEW.pin_hash) < 16
  OR length(NEW.pin_hash) > 200
BEGIN
  SELECT RAISE(ABORT, 'staff pin verifier is malformed');
END;

CREATE TRIGGER shop_timezone_shape_insert
BEFORE INSERT ON shop
WHEN length(NEW.timezone) < 1 OR length(NEW.timezone) > 64
BEGIN
  SELECT RAISE(ABORT, 'shop timezone is malformed');
END;

CREATE TRIGGER shop_timezone_shape_update
BEFORE UPDATE OF timezone ON shop
WHEN length(NEW.timezone) < 1 OR length(NEW.timezone) > 64
BEGIN
  SELECT RAISE(ABORT, 'shop timezone is malformed');
END;
