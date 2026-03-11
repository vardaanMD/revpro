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
  return (
    <s-stack direction="block" gap="small">
      <div className={styles.labelRow}>
        <label htmlFor={name}>{label}</label>
        {infoTip && (
          <span className={styles.infoWrap}>
            <button type="button" className={styles.infoButton} aria-label="More info" tabIndex={0}>ⓘ</button>
            <span role="tooltip" className={styles.tooltip}>{infoTip}</span>
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
