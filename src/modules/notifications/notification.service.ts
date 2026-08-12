import { pool } from '../../db/pool';
import { supabaseAdmin } from '../../config/supabase';

/**
 * Notification service — transactional outbox poller.
 *
 * B3: ORDER_CREATED events are written to event_outbox in the same
 * transaction as the order. This poller reads unpublished events and
 * publishes them to Supabase Realtime.
 *
 * Failure handling:
 * - retry_count tracks failed publication attempts
 * - After 5 failures, the event becomes a dead-letter (retry_count = 5)
 * - Dead-letter events are NOT deleted — they remain queryable for monitoring
 * - Order success is COMPLETELY DECOUPLED from notification delivery
 *
 * IMPORTANT limitation (documented honestly):
 * Supabase Realtime broadcast is ephemeral pub/sub. If the seller's
 * client is not connected when we publish, they will NOT receive the
 * notification — even though published = true in our outbox.
 * A durable notification_history table is a planned future improvement.
 * See README D2 for details.
 */

let pollerInterval: ReturnType<typeof setInterval> | null = null;

export async function processOutbox(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE SKIP LOCKED: if we run multiple pollers (e.g., in tests),
    // they safely skip rows locked by other pollers — no double-publishing.
    const { rows: events } = await client.query<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
      retry_count: number;
    }>(
      `SELECT id, event_type, payload, retry_count
       FROM event_outbox
       WHERE published = false AND retry_count < 5
       ORDER BY created_at ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED`
    );

    for (const event of events) {
      try {
        // Publish to Supabase Realtime on the 'order-events' channel
        // Sellers listen to this channel for new order notifications
        await supabaseAdmin.channel('order-events').send({
          type: 'broadcast',
          event: event.event_type,
          payload: event.payload,
        });

        await client.query(
          `UPDATE event_outbox
           SET published = true, published_at = now()
           WHERE id = $1`,
          [event.id]
        );
      } catch {
        // Increment retry count — event becomes dead-letter after 5 failures
        await client.query(
          `UPDATE event_outbox
           SET retry_count = retry_count + 1
           WHERE id = $1`,
          [event.id]
        );
      }
    }

    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

/** Start the outbox poller. Called once from app startup. */
export function startOutboxPoller(): void {
  if (pollerInterval) return;
  pollerInterval = setInterval(processOutbox, 2000);
  console.log('📬 Outbox poller started (2s interval)');
}

/** Stop the outbox poller. Called from graceful shutdown. */
export function stopOutboxPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
