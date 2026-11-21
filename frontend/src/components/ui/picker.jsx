import { useLayoutEffect, useRef } from "react";
import PocketmarkSelect from "../../../../internal/webui/static/select.js";

// The shared picker owns its portaled menu and listeners while this field is mounted.
export function Picker({ label, children, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const picker = PocketmarkSelect.enhance(ref.current);
    return () => picker.destroy();
  }, []);
  useLayoutEffect(() => {
    PocketmarkSelect.sync(ref.current);
  }, [props.value, props.disabled]);
  return (
    <select ref={ref} aria-label={label} {...props}>
      {children}
    </select>
  );
}
