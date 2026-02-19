-- Migration 003: Add services catalogue + booking price snapshot + stripe ref

-- 1. Services catalogue table
CREATE TABLE IF NOT EXISTS services (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description_short TEXT,
    price_cents INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_services_is_active ON services(is_active);
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);

-- 2. Seed 15 services across 4 categories
INSERT INTO services (id, category, name, description_short, price_cents) VALUES
    -- Plumbing (4)
    ('a0000000-0000-0000-0000-000000000001', 'Plumbing', 'Burst Pipe Repair', 'Emergency burst pipe fix', 85000),
    ('a0000000-0000-0000-0000-000000000002', 'Plumbing', 'Blocked Drain', 'Unblock kitchen or bathroom drain', 45000),
    ('a0000000-0000-0000-0000-000000000003', 'Plumbing', 'Geyser Service', 'Geyser inspection and maintenance', 120000),
    ('a0000000-0000-0000-0000-000000000004', 'Plumbing', 'Toilet Repair', 'Fix leaking or running toilet', 35000),
    -- Electrical (4)
    ('b0000000-0000-0000-0000-000000000001', 'Electrical', 'DB Board Trip', 'Diagnose and fix tripping breaker', 55000),
    ('b0000000-0000-0000-0000-000000000002', 'Electrical', 'Light Fitting Install', 'Install new light fixture', 30000),
    ('b0000000-0000-0000-0000-000000000003', 'Electrical', 'Electrical CoC', 'Certificate of Compliance inspection', 150000),
    ('b0000000-0000-0000-0000-000000000004', 'Electrical', 'Plug Point Install', 'Add new wall plug point', 40000),
    -- Cleaning (4)
    ('c0000000-0000-0000-0000-000000000001', 'Cleaning', 'Deep Clean (House)', 'Full house deep clean', 95000),
    ('c0000000-0000-0000-0000-000000000002', 'Cleaning', 'Office Clean', 'Standard office cleaning', 75000),
    ('c0000000-0000-0000-0000-000000000003', 'Cleaning', 'Post-Construction Clean', 'Cleanup after building work', 130000),
    ('c0000000-0000-0000-0000-000000000004', 'Cleaning', 'Carpet Shampoo', 'Deep carpet cleaning per room', 25000),
    -- Handyman (3)
    ('d0000000-0000-0000-0000-000000000001', 'Handyman', 'Furniture Assembly', 'Assemble flat-pack furniture', 35000),
    ('d0000000-0000-0000-0000-000000000002', 'Handyman', 'Wall Mounting', 'Mount TV or shelves', 25000),
    ('d0000000-0000-0000-0000-000000000003', 'Handyman', 'Door Repair', 'Fix sticking or broken door', 30000)
ON CONFLICT (id) DO NOTHING;

-- 3. Add snapshot columns to bookings (nullable for backward compatibility)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='service_name_snapshot') THEN
        ALTER TABLE bookings ADD COLUMN service_name_snapshot TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='price_snapshot_cents') THEN
        ALTER TABLE bookings ADD COLUMN price_snapshot_cents INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='stripe_payment_intent_id') THEN
        ALTER TABLE bookings ADD COLUMN stripe_payment_intent_id TEXT;
    END IF;
END $$;

INSERT INTO schema_versions (version) VALUES (3) ON CONFLICT (version) DO NOTHING;
