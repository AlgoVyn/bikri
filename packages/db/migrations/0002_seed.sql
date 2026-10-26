-- Bikri seed data. Source: docs/02-data-model.md §2.1.

INSERT INTO expense_category_templates (code, name_en, name_ur, icon, sort_order) VALUES
 ('electricity','Electricity','بجلی','bolt',1),
 ('tea_snacks','Tea & snacks','چائے پانی','cup',2),
 ('transport','Transport','کرایہ','truck',3),
 ('salary','Salary','تنخواہ','users',4),
 ('rent','Rent','کرایہ دکان','home',5),
 ('repairs','Repairs','مرمت','wrench',6),
 ('internet_phone','Internet & phone','انٹرنیٹ و فون','wifi',7),
 ('other','Other','دیگر','dots',99);
