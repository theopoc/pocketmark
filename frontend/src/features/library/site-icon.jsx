import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../../components/icon";

// Bound network work without retaining a favicon cache in application memory.
let active = 0;
const queue = [];
function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    if (job.cancelled) continue;
    active++;
    const image = new Image();
    function finish(ok) {
      active--;
      if (!job.cancelled) job.done(ok);
      pump();
    }
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = job.url;
  }
}

let media;
const desktop = () => (media ||= window.matchMedia("(min-width: 901px)"));
function subscribe(listener) {
  desktop().addEventListener("change", listener);
  return () => desktop().removeEventListener("change", listener);
}

export function SiteIcon({ link, view }) {
  const wide = useSyncExternalStore(
    subscribe,
    () => desktop().matches,
    () => false,
  );
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const url = `/api/links/${link.id}/favicon?v=${encodeURIComponent(link.updatedAt || "")}`;
  useEffect(() => {
    if (view !== "list" || !wide || link.type === "file" || loaded) return;
    let timer;
    const job = {
      url,
      cancelled: false,
      done(ok) {
        if (ok) setLoaded(true);
        else if (!retry) timer = setTimeout(() => setRetry(1), 2000);
      },
    };
    queue.push(job);
    pump();
    return () => {
      job.cancelled = true;
      clearTimeout(timer);
    };
  }, [view, wide, url, retry, loaded, link.type]);
  return (
    <span className="card-site-mark" aria-hidden="true">
      {link.type === "file" ? (
        "F"
      ) : loaded ? (
        <img src={url} alt="" decoding="async" />
      ) : (
        <Icon name="bookmark" />
      )}
    </span>
  );
}
