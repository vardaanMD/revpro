import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./FormField.module.css";

type FormFieldProps = {
  label: string;
  id?: string;
  children: ReactNode;
  helperText?: string;
  error?: string;
  infoTip?: string;
};

export function FormField({
  label,
  id,
  children,
  helperText,
  error,
  infoTip,
}: FormFieldProps) {
  const fieldId = id ?? label.replace(/\s+/g, "-").toLowerCase();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const infoButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!tooltipOpen) return;
    const updatePosition = () => {
      const rect = infoButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltipPos({
        left: rect.left + rect.width / 2,
        top: rect.top - 8,
      });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [tooltipOpen]);

  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={fieldId}>
          {label}
        </label>
        {infoTip && (
          <span
            className={styles.infoWrap}
            onMouseEnter={() => setTooltipOpen(true)}
            onMouseLeave={() => setTooltipOpen(false)}
          >
            <button
              ref={infoButtonRef}
              type="button"
              className={styles.infoButton}
              aria-label="More info"
              aria-expanded={tooltipOpen}
              aria-describedby={tooltipOpen ? `${fieldId}-tooltip` : undefined}
              tabIndex={0}
              onFocus={() => setTooltipOpen(true)}
              onBlur={() => setTooltipOpen(false)}
            >
              ⓘ
            </button>
            {mounted && tooltipOpen && createPortal(
              <span
                id={`${fieldId}-tooltip`}
                role="tooltip"
                className={styles.tooltipFloating}
                style={{ left: tooltipPos.left, top: tooltipPos.top }}
              >
                {infoTip}
              </span>,
              document.body
            )}
          </span>
        )}
      </div>
      <div className={styles.control}>{children}</div>
      {helperText != null && helperText !== "" && !error && (
        <span className={styles.helper}>{helperText}</span>
      )}
      {error != null && error !== "" && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
