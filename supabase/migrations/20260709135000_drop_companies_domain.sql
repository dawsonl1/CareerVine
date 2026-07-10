-- Drop companies.domain — website isn't stored or shown in the product.
ALTER TABLE companies DROP COLUMN IF EXISTS domain;
