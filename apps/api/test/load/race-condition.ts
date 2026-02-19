import { buildServer } from '../../src/app.js';
import { query } from '../../src/db.js';

async function runLoadSim() {
    console.log('🚀 Starting Friday Rush Load Simulation...');
    const app = await buildServer();

    const CUSTOMER_UID = '550e8400-e29b-41d4-a716-446655440003';
    const SERVICE_ID = '550e8400-e29b-41d4-a716-446655440001';
    const SLOT_ID = '550e8400-e29b-41d4-a716-446655440002';

    // 1. Setup: Clean DB and create candidates
    await query('TRUNCATE providers, provider_services, bookings, booking_events, payment_intents, webhook_events RESTART IDENTITY CASCADE');

    const providerIds = [];
    for (let i = 0; i < 50; i++) {
        const pid = `550e8400-e29b-41d4-a716-4466554400${i.toString().padStart(2, '0')}`;
        providerIds.push(pid);
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': pid, 'x-role': 'provider' },
            payload: { display_name: `Provider ${i}`, is_online: true, services: [SERVICE_ID] },
        });
    }

    // 2. Create and Paid booking
    const createRes = await app.inject({
        method: 'POST',
        url: '/v1/bookings',
        headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
        payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_UID },
    });
    const bookingId = createRes.json().id;

    // Manually force to PAID (mimicking webhook success)
    await query("UPDATE bookings SET status = 'PAID' WHERE id = $1", [bookingId]);

    console.log(`📦 Booking ${bookingId} created and set to PAID. Firing 50 concurrent accepts...`);

    // 3. Fire 50 parallel requests
    const startTime = Date.now();
    const results = await Promise.all(
        providerIds.map(pid =>
            app.inject({
                method: 'POST',
                url: `/v1/bookings/${bookingId}/accept`,
                headers: { 'x-user-id': pid, 'x-role': 'provider' },
            })
        )
    );
    const duration = Date.now() - startTime;

    // 4. Analyze Results
    let successCount = 0;
    let failureCount = 0;
    const errorCodes = {};

    results.forEach(res => {
        if (res.statusCode === 200) {
            successCount++;
        } else {
            failureCount++;
            const err = res.json().error || 'unknown';
            errorCodes[err] = (errorCodes[err] || 0) + 1;
        }
    });

    console.log('\n--- Simulation Results ---');
    console.log(`Duration: ${duration}ms`);
    console.log(`Successes: ${successCount}`);
    console.log(`Failures: ${failureCount}`);
    console.log('Error Distribution:', JSON.stringify(errorCodes, null, 2));

    // 5. Final Assertions
    if (successCount !== 1) {
        console.error(`❌ FAILURE: Expected exactly 1 success, but got ${successCount}`);
        process.exit(1);
    }

    const finalBooking = await query('SELECT status, provider_id FROM bookings WHERE id = $1', [bookingId]);
    console.log(`Final Booking Status: ${finalBooking.rows[0].status}`);
    console.log(`Accepted by: ${finalBooking.rows[0].provider_id}`);

    if (finalBooking.rows[0].status !== 'IN_PROGRESS') {
        console.error('❌ FAILURE: Booking is not IN_PROGRESS');
        process.exit(1);
    }

    console.log('✅ SUCCESS: Atomic accept validated under stress.');
    await app.close();
    process.exit(0);
}

runLoadSim();
