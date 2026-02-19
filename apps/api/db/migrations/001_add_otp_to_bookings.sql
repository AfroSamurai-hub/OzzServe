-- Migration 001: Add OTP to bookings
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='otp') THEN
        ALTER TABLE bookings ADD COLUMN otp TEXT;
    END IF;
END $$;

INSERT INTO schema_versions (version) VALUES (1) ON CONFLICT (version) DO NOTHING;
