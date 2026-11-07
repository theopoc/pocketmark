import { iconPaths } from "../lib/icons";

export function Icon({ name, ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="icon"
      {...props}
    >
      {(iconPaths[name] || iconPaths.bookmark).map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
