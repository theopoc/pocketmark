// Section IDs are public routes. Group, label and search terms share one catalog.
export const settingsGroups = [
  {
    name: "Library",
    entries: [
      {
        id: "appearance",
        icon: "sun",
        name: "Appearance",
        description: "Theme and keyboard shortcuts",
        keywords: "dark light color preferences",
      },
      {
        id: "backup",
        icon: "download",
        name: "Backup & restore",
        description: "Schedule remote backups, review runs and restore a copy",
        keywords: "archive export",
      },
    ],
  },
  {
    name: "Account & security",
    entries: [
      {
        id: "2fa",
        icon: "shield",
        name: "Two-factor authentication",
        description: "Manage your authenticator app",
        keywords: "mfa totp sign-in",
      },
      {
        id: "sessions",
        icon: "monitor",
        name: "Browser sessions",
        description: "Review devices, IP addresses and activity",
        keywords: "revoke login ipv4 ipv6",
      },
      {
        id: "password",
        icon: "lock",
        name: "Password",
        description: "Update your sign-in details",
        keywords: "username login",
      },
    ],
  },
  {
    name: "Connected apps",
    entries: [
      {
        id: "ai-tagging",
        icon: "tag",
        name: "AI tagging",
        description: "Classify untagged bookmarks with your ChatGPT plan",
        keywords: "model classify scan automatic tags OpenAI provider",
      },
      {
        id: "api-keys",
        icon: "key",
        name: "API keys",
        description: "Manage access for apps and extensions",
        keywords: "token permissions role disable revoke last activity",
      },
      {
        id: "sync",
        icon: "refresh",
        name: "Browser bookmark sync",
        description: "Connect Floccus over WebDAV",
        keywords: "xbel",
      },
      {
        id: "mobile",
        icon: "book",
        name: "Mobile & browser",
        description: "Install Pocketmark and save from Chrome",
        keywords: "phone extension",
      },
    ],
  },
];
export const settingsEntries = settingsGroups.flatMap(
  ({ name: group, entries }) => entries.map((entry) => ({ ...entry, group })),
);
