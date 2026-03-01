import type { ReactNode } from "react";
import styles from "./FormField.module.css";

type FormFieldProps = {
  label: string;
  id?: string;
  children: ReactNode;
  helperText?: string;
  error?: string;
};

export function FormField({
  label,
  id,
  children,
  helperText,
  error,
}: FormFieldProps) {
  const fieldId = id ?? label.replace(/\s+/g, "-").toLowerCase();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={fieldId}>
        {label}
      </label>
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
