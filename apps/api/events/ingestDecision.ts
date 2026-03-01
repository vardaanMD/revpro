import { getDbClient } from "../db/client";

export interface DecisionRecordInput {
  storeId: string;
  sessionId: string;
  decisionType: string;
  inputSnapshot: unknown;
  output: unknown;
}

export async function ingestDecision(input: DecisionRecordInput): Promise<void> {
  const pool = getDbClient();
  await pool.query(
    `
      INSERT INTO decisions (store_id, session_id, decision_type, input_snapshot, output)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      input.storeId,
      input.sessionId,
      input.decisionType,
      JSON.stringify(input.inputSnapshot),
      JSON.stringify(input.output),
    ]
  );
}
