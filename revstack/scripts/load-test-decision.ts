/**
 * Load test script for POST /cart/decision.
 * DEV only — ensure NODE_ENV=development and dev server is running with DEV_SKIP_PROXY=1.
 * Node 18+ compatible.
 */

if (process.env.NODE_ENV !== "development") {
  console.error("load:test must run in development (NODE_ENV=development). Aborting.");
  process.exit(1);
}

import autocannon from "autocannon";

const PORT = Number(process.env.PORT) || 3000;
const BASE = `http://localhost:${PORT}`;
const PATH = "/cart/decision";
const DURATION = 20;
const CONNECTIONS = 20;
const PIPELINING = 1;

const body = JSON.stringify({
  cart: {
    currency: "INR",
    total_price: 450000,
    items: [
      {
        key: "abc123",
        product_id: "1234567890",
        variant_id: "1234567890",
        price: 150000,
        final_line_price: 150000,
        quantity: 3,
      },
    ],
  },
});

async function run(): Promise<void> {
  const result = await autocannon({
    url: `${BASE}${PATH}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
    duration: DURATION,
    connections: CONNECTIONS,
    pipelining: PIPELINING,
  });

  console.log("\n--- cart.decision load test results ---\n");
  console.log("Latency (ms):");
  console.log("  p50:", result.latency.p50);
  console.log("  p95:", result.latency.p97_5); // p97.5 (autocannon’s nearest to p95)
  console.log("  p99:", result.latency.p99);
  console.log("\nRequests:");
  console.log("  average (req/s):", result.requests.average);
  console.log("\nThroughput:");
  console.log("  average (bytes/s):", result.throughput.average);
  console.log("\n----------------------------------------\n");
}

run().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
