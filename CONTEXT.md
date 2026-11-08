# Pocketmark vocabulary

## Language

- **Basic capture** is the server’s bounded fetch of a bookmark’s public HTML and extracted text. Changing the bookmark URL queues a new capture.
- **Attachment** is a saved file associated with a library record. A browser capture or manual offline snapshot can add one. [Archive formats and limits](docs/ARCHIVES.md).
- **Full backup** is a consistent SQLite snapshot with library data, captures, attachments and account records. Keep the internal server secret separately. A metadata export contains bookmark metadata for transfer. [Backup and restore](docs/GUIDE.md#back-up-everything).

### Image delivery

See [version images and published-image qualification](docs/RELEASE.md#ghcr-images).
