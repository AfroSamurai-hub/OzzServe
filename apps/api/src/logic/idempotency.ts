/**
 * Webhook Idempotency Module
 * Ensures duplicate events produce no second side-effect.
 */

// In-memory store for exploration/POC; DB needed later.
const processedEventIds = new Set<string>();

export function isNewEvent(eventId: string): boolean {
    if (processedEventIds.has(eventId)) {
        return false;
    }
    processedEventIds.add(eventId);
    return true;
}

// For testing purposes
export function clearEvents() {
    processedEventIds.clear();
}
