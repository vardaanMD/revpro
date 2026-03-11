import type { ReactNode } from "react";
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
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={fieldId}>
          {label}
        </label>
        {infoTip && (
          <span className={styles.infoWrap}>
            <button type="button" className={styles.infoButton} aria-label="More info" tabIndex={0}>ⓘ</button>
            <span role="tooltip" className={styles.tooltip}>{infoTip}</span>
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
