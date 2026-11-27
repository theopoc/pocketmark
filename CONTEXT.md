# Pocketmark vocabulary

## Language

- **Basic capture** is the server’s bounded fetch of a bookmark’s public HTML and extracted text. Changing the bookmark URL queues a new capture.
- **Attachment** is a saved file associated with a library record. A browser capture or manual offline snapshot can add one. [Archive formats and limits](docs/ARCHIVES.md).
- **Full backup** is a consistent copy of the library, captures, attachments and account records used to restore a Pocketmark instance. Recovery also requires the original server secret, kept separately. [Backup and restore](docs/GUIDE.md#back-up-everything).
- **Metadata export** contains bookmark metadata for transfer between libraries.
- **AI tagging** assigns lowercase English tags to an untagged website bookmark. It reuses relevant English tags from the library and can create new ones when none fit.
- **AI-public metadata** is what AI tagging may send to its provider: a title or description the owner entered, and what basic capture found on the public page, including a short excerpt. Personal notes, attachments, text uploaded from the owner’s browser and URL parameters stay local; a URL used as a fallback title is omitted.
- **Metadata source** is where a bookmark’s title and description came from: the owner, basic capture, a browser upload, or an imported or synced record whose marker says which fields are AI-public. It decides whether each field is AI-public.
- **Backup schedule** is the recurring time and choice of contents for an instance’s remote backups.
- **Backup run** is one scheduled or owner-triggered operation to save a restore point in the configured remote storage. Retries belong to the same run.
- **Backup window** is the time a remote backup run has to produce a verified copy and complete required retention, including time spent retrying. A manual request waiting for an earlier run to finish gets its own window when it starts.

### Image delivery

See [version images and published-image qualification](docs/RELEASE.md#ghcr-images).
