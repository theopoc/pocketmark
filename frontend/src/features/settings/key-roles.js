export const keyRoles = {
  read: {
    label: "Reader",
    description:
      "Can read and export library data, including saved files. Cannot change it.",
  },
  capture: {
    label: "Editor",
    description:
      "Can read bookmark metadata, add or edit bookmarks, create collections and upload captures. Cannot delete, bulk edit, import, export or download saved files.",
  },
  sync: {
    label: "Sync",
    description:
      "WebDAV only. Can read and replace the bookmark tree, including deletions. Cannot access the native library API or saved files.",
  },
  full: {
    label: "Full Access",
    description:
      "Can read, export, change and delete library data, including WebDAV sync. Cannot manage your account, keys, sessions or full backups.",
  },
};
