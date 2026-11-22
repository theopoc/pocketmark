export const keyRoles = {
  read: {
    label: "Reader",
    icon: "book",
    summary: "Read and export",
    description:
      "Can read and export library data, including saved files. Cannot change it.",
  },
  capture: {
    label: "Editor",
    icon: "edit",
    summary: "Edit and capture",
    description:
      "Can read bookmark metadata, add or edit bookmarks, create collections and upload captures. Cannot delete, bulk edit, import, export or download saved files.",
  },
  sync: {
    label: "Sync",
    icon: "refresh",
    summary: "WebDAV bookmark sync",
    description:
      "WebDAV only. Can read and replace the bookmark tree, including deletions. Cannot access the native library API or saved files.",
  },
  full: {
    label: "Full Access",
    icon: "library",
    summary: "Manage library data",
    description:
      "Can read, export, change and delete library data, including WebDAV sync. Cannot manage your account, keys, sessions or full backups.",
  },
};

export function displayKeyRole(profile) {
  return (
    keyRoles[profile] || {
      label: profile || "Unknown role",
      icon: "key",
      summary: "Unknown permissions",
      description: "Permission details are unavailable for this role.",
    }
  );
}

export function keyExpired(key, now = Date.now()) {
  return key.expiresAt > 0 && key.expiresAt * 1000 <= now;
}

export function keyStatus(key, now = Date.now()) {
  if (!key.active) return "Disabled";
  return keyExpired(key, now) ? "Expired" : "Active";
}

export function keyNameError(value) {
  const name = value.trim();
  return !name || new TextEncoder().encode(name).length > 120
    ? "Enter a name of 1–120 bytes."
    : "";
}
