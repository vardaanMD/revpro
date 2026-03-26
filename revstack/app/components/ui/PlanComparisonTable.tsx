import { Form } from "react-router";
import type { Plan } from "~/lib/capabilities.server";
import styles from "./PlanComparisonTable.module.css";

type PlanRow = {
  id: Plan;
  name: string;
  price: string;
  orderLimit: string;
  benefits: string[];
  description: string;
  recommended?: boolean;
  mostPopular?: boolean;
};

type PlanComparisonTableProps = {
  plans: PlanRow[];
  currentPlan?: Plan;
  isSubmitting?: boolean;
  monthlyOrderCount?: number;
  orderLimit?: number;
};

/**
 * Usage-based plan comparison table. All plans share the same features;
 * tiers differ by monthly order volume.
 */
export function PlanComparisonTable({
  plans,
  currentPlan,
  isSubmitting = false,
  monthlyOrderCount = 0,
  orderLimit = 0,
}: PlanComparisonTableProps) {
  return (
    <div className={styles.tableWrapper}>
      {currentPlan && orderLimit < Infinity && (
        <div className={styles.usageBanner}>
          <s-text tone="neutral">
            This month: <strong>{monthlyOrderCount.toLocaleString()}</strong> / {orderLimit.toLocaleString()} orders
          </s-text>
        </div>
      )}
      <div className={styles.plansGrid}>
        {plans.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          return (
            <div key={plan.id} className={`${styles.planCard} ${isCurrent ? styles.currentPlanCard : plan.recommended ? styles.recommended : plan.mostPopular ? styles.mostPopular : ""}`.trim()}>
              {isCurrent && (
                <span className={styles.badgeCurrent}>Current plan</span>
              )}
              {plan.mostPopular && !isCurrent && (
                <span className={styles.badgeMostPopular}>Most popular</span>
              )}
              {plan.recommended && !isCurrent && !plan.mostPopular && (
                <span className={styles.badge}>Recommended</span>
              )}
              <s-box
                padding="large"
                borderWidth="base"
                borderRadius="base"
                background={plan.recommended || plan.mostPopular ? "base" : "subdued"}
              >
                <div className={styles.cardContent}>
                  <div className={styles.cardTop}>
                    <s-heading>{plan.name}</s-heading>
                    <div className={styles.priceBlock}>
                      <span className={styles.planPrice}>{plan.price.replace("/mo", "")}</span>
                      <span className={styles.pricePeriod}>/mo</span>
                    </div>
                    <span className={styles.orderLimit}>{plan.orderLimit}</span>
                    <p className={styles.description}>
                      <s-text tone="neutral">{plan.description}</s-text>
                    </p>
                    <div className={styles.divider} />
                    <ul className={styles.benefits}>
                      {plan.benefits.map((b, i) => (
                        <li key={i}>
                          <s-text tone="neutral">{b}</s-text>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className={styles.cardBottom}>
                    <Form method="post">
                      <input type="hidden" name="planId" value={plan.id} />
                      <s-button
                        type="submit"
                        variant={plan.recommended ? "primary" : "secondary"}
                        disabled={isCurrent || isSubmitting}
                        loading={isSubmitting && !isCurrent}
                      >
                        {isCurrent ? "Current plan" : isSubmitting ? "Upgrading…" : `Activate ${plan.name}`}
                      </s-button>
                    </Form>
                  </div>
                </div>
              </s-box>
            </div>
          );
        })}
      </div>
    </div>
  );
}
