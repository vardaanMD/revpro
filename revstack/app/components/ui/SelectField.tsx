import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./SelectField.module.css";

type SelectOption = {
  label: string;
  value: string;
};

type SelectFieldProps = {
  label: string;
  name: string;
  value: string;
  options: SelectOption[];
  onChange?: (value: string) => void;
  infoTip?: string;
};

export function SelectField({
  label,
  name,
  value,
  options,
  onChange,
  infoTip,
}: SelectFieldProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const infoButtonRef = useRef<HTMLButtonElement | null>(null);
  const tooltipId = `${name}-tooltip`;

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
    <s-stack direction="block" gap="small">
      <div className={styles.labelRow}>
        <label htmlFor={name}>{label}</label>
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
              aria-describedby={tooltipOpen ? tooltipId : undefined}
              tabIndex={0}
              onFocus={() => setTooltipOpen(true)}
              onBlur={() => setTooltipOpen(false)}
            >
              ⓘ
            </button>
            {mounted && tooltipOpen && createPortal(
              <span
                id={tooltipId}
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
      <select
        id={name}
        name={name}
        value={value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className={styles.select}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </s-stack>
  );
}
