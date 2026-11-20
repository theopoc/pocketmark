import { Icon } from "../../components/icon";

const browserMarks = {
  Chrome: (
    <>
      <circle cx="16" cy="16" r="15" fill="#fbbc04" />
      <path
        d="M3 8.5A15 15 0 0 1 29 8.5H16a7.5 7.5 0 0 0-6.5 11.25Z"
        fill="#ea4335"
      />
      <path
        d="M3 8.5l6.5 11.25a7.5 7.5 0 0 0 13 0L16 31A15 15 0 0 1 3 8.5Z"
        fill="#34a853"
      />
      <circle
        cx="16"
        cy="16"
        r="7"
        fill="#4285f4"
        stroke="#fff"
        strokeWidth="1.5"
      />
    </>
  ),
  Safari: (
    <>
      <circle cx="16" cy="16" r="15" fill="#16a7f4" />
      <circle
        cx="16"
        cy="16"
        r="12"
        fill="#1385e1"
        stroke="white"
        strokeWidth="1.6"
        strokeDasharray=".8 1.9"
      />
      <path d="m24.8 6.6-6.3 11.9-4.9-4.9Z" fill="#fb5049" />
      <path d="m7.2 25.4 6.4-11.8 4.9 4.9Z" fill="#fff" />
      <path d="m24.8 6.6-8.8 9.4 2.5 2.5Z" fill="#dd322c" />
    </>
  ),
  Firefox: (
    <>
      <circle cx="16" cy="17" r="13" fill="#7547db" />
      <path
        d="M6 4.2c1.6 1.7 3.7 2.4 5.1 3.1 1.2-2.6 4.1-4.8 7.6-6.3-.5 2.8.6 4.4 3.4 6.6 3 2.4 4.8 5.1 4.8 8.9 1.8-1.2 2.6-3.6 2.3-6.1 4.5 8.5-.7 20.3-12.6 20.3-9 0-14.6-6.1-14.6-13.2 0-3.7 1.2-6.4 3.2-8.5-.3-1.8 0-3.5.8-4.8Z"
        fill="#ff7b17"
      />
      <path
        d="M4 10c-.6 6 2.4 8.9 6.6 9.6-3.4-3.5-1.4-7.3 1.8-8.6l2.9 2.3-2 1.1c-2.2 4.1.4 8.7 5 8.7 3.8 0 6.9-2.2 8.4-5.9-.6 6.6-5.2 10.9-11.6 10.9C7.3 28.1 2.1 20.2 4 10Z"
        fill="#ffb52b"
      />
      <path
        d="M6.4 24.5c4.4 3.2 11.5 3.8 16.8.4-2.9 4.2-10.5 6-16.8-.4Z"
        fill="#ff4640"
      />
    </>
  ),
  Edge: (
    <>
      <path
        d="M2 17C1 8 8 1 16 1c8 0 14.4 5.7 14.4 13.2 0 5.4-3.2 8.5-8.3 8.5-4 0-6.6-2.2-6.6-5.4 1.7 1.6 5.7 1.2 5.7-2.2 0-2.9-3.5-5.2-7.1-5.2-5.2 0-9 2.5-12.1 7.1Z"
        fill="#04b7a5"
      />
      <path
        d="M2 17c2.3-6.3 7.9-9 13-8 3.1.6 5.8 2.7 6.2 5.1-1.1-1.2-3.3-2.1-5.5-2.1-4 0-6.3 2.7-6.3 5.6 0 5.8 5.6 9.8 12 9.8 2.1 0 4.2-.4 5.8-1.2a15 15 0 0 1-25.2-9.2Z"
        fill="#087bd6"
      />
      <path
        d="M9.4 17.6c1.4 4.4 5.6 7.1 12.4 7.1 2.4 0 4.6-.4 6.7-1.3-.3 1.1-.9 2.2-1.5 3-6.7 4.6-18.1 1.6-17.6-8.8Z"
        fill="#0758aa"
      />
    </>
  ),
};
export function SessionBrowserIcon({ browser, mobile }) {
  const mark = browserMarks[browser];
  return (
    <span className="session-browser-icon" aria-hidden="true">
      {mark ? (
        <svg viewBox="0 0 32 32" focusable="false">
          {mark}
        </svg>
      ) : (
        <Icon name={mobile ? "phone" : "monitor"} />
      )}
    </span>
  );
}
