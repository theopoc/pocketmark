# Limit what AI tagging sends from the library

The owner requested one exception to Pocketmark's general exclusion of product automations. Its scope is classifying untagged website bookmarks.

AI tagging assigns up to three tags, giving priority to the owner's existing tags. When the owner enables it, creating an untagged website bookmark from the web interface, browser extension or API triggers classification in the background. The bookmark is saved immediately. The provider may receive the bookmark's title, domain, description, existing tag names and a short excerpt from Pocketmark's basic capture of the public page. Personal notes, attachments (including text extracted from browser uploads) and URL parameters stay local. These boundaries apply to every classification, including the owner's first run over an existing library.

If basic capture fails, is disabled or takes too long, classification uses the available metadata. A bookmark URL used as a fallback title is omitted from the request. When the domain is the only clue, Pocketmark leaves the bookmark untagged.

Imports and Floccus synchronization can add thousands of bookmarks at once. The owner can include those links and older untagged bookmarks by starting a scan in settings, where Pocketmark shows the eligible count before consuming the owner's ChatGPT plan allowance. Standalone files are outside the scope of AI tagging.

When no existing tag fits, the classifier may propose new lowercase topic tags. This also allows a library to start with no tags. If any existing tags fit, Pocketmark applies only those matches. New tags enter the vocabulary as soon as they are saved to a bookmark.

Starting a new manual scan includes every eligible bookmark that currently has no tags, even if the owner removed its last tag or a previous scan found no match. The classifier may assign a previously removed tag again. Removing a tag does not itself trigger classification. If the owner adds a tag while a request is running, Pocketmark preserves that edit and discards the proposed tags.

## Tag names

Lowercase tag names apply throughout the library, including manual edits, bulk edits, extension and API writes, imports, and AI tagging. The migration converts existing tag names to lowercase and merges names that differ only by case. Bookmarks tagged `AWS` or `aws` all retain `aws`. A bookmark that carried both retains one occurrence. The same lowercase convention applies to tags proposed by the classifier.

Interior spaces and punctuation are preserved. `Machine Learning` becomes `machine learning` and remains distinct from `machine-learning`.

## Settings and quota

In AI tagging settings, the owner connects a ChatGPT plan, selects a model, tests it with a fictional example and enables automatic tagging. The same screen shows the eligible count and starts a scan of untagged bookmarks. The owner can pause tagging while keeping the account connected, or disconnect it.

If the plan reaches its usage limit during a scan, Pocketmark saves progress and shows how many bookmarks remain. It resumes at the time supplied by the provider when available. Otherwise, the owner can resume from settings. A resumed scan skips bookmarks it has already processed, including bookmarks that had insufficient public information to classify.
