-- Bikri seed data. Source: docs/02-data-model.md §2.1.

INSERT INTO expense_categories (id, code, name_en, name_ur, icon, is_system, sort_order, created_at, updated_at) VALUES
 ('electricity','electricity','Electricity','بجلی','bolt',1,1,0,0),  -- created_at/updated_at 0 = system seed (EpochMs allows 0)
 ('tea_snacks','tea_snacks','Tea & snacks','چائے پانی','cup',1,2,0,0),
 ('transport','transport','Transport','کرایہ','truck',1,3,0,0),
 ('salary','salary','Salary','تنخواہ','users',1,4,0,0),
 ('rent','rent','Rent','کرایہ دکان','home',1,5,0,0),
 ('repairs','repairs','Repairs','مرمت','wrench',1,6,0,0),
 ('internet_phone','internet_phone','Internet & phone','انٹرنیٹ و فون','wifi',1,7,0,0),
 ('other','other','Other','دیگر','dots',1,99,0,0);
