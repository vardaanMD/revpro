/**
 * =============================================================================
 * DEPRECATED — This backend is not used by the Shopify storefront.
 * revstack is the canonical backend.
 * Do not modify or deploy this backend unless multi-platform is reintroduced.
 * =============================================================================
 */
import 'dotenv/config'
import cors from "cors";
import express from "express";
import cartRouter from "./routes/cart";
import decisionRouter from "./routes/decision";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/cart", cartRouter);
app.use("/cart", decisionRouter);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT);

export default app;



