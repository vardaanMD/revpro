import { getDbClient } from "../db/client";

export interface EventInput {
  storeId: string;
  sessionId: string;
  type: string;
  payload: unknown;
}

export async function ingestEvent(input: EventInput): Promise<void> {
  const pool = getDbClient();
  await pool.query(
    `
      INSERT INTO events (store_id, session_id, type, payload)
      VALUES ($1, $2, $3, $4)
    `,
    [input.storeId, input.sessionId, input.type, JSON.stringify(input.payload)]
  );
}
