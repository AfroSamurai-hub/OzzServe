-- Migration 002: Add notifications and issue handling
CREATE TABLE IF NOT EXISTS notification_outbox (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    recipient_uid TEXT NOT NULL, -- UID from Firebase
    type TEXT NOT NULL, -- e.g. 'PROVIDER_CANCELLED', 'PAYMENT_FAILED', 'ISSUE_FLAGGED'
    payload JSONB,
    status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'SENT', 'FAILED'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status ON notification_outbox(status);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_booking_id ON notification_outbox(booking_id);

-- Add complete_pending_until to bookings for grace window tracking if not exists
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='complete_pending_until') THEN
        ALTER TABLE bookings ADD COLUMN complete_pending_until TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

INSERT INTO schema_versions (version) VALUES (2) ON CONFLICT (version) DO NOTHING;
