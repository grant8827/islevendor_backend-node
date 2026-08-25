/*
  Warnings:

  - Added the required column `location` to the `warehouses` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "driver_profiles" ADD COLUMN     "current_location" geometry(Point, 4326);

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "location" geometry(Point, 4326) NOT NULL;
