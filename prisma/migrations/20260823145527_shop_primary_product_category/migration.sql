-- ISLE-103: primary product category hint captured at small-vendor signup.
ALTER TABLE "shops" ADD COLUMN     "primary_product_category" TEXT;
