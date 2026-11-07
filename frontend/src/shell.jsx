import { useLayoutEffect } from "react";
import { LoginView } from "./components/login-view";
import { AppView } from "./components/app-view";
import { NavigationDialog } from "./components/navigation-dialog";
import { DeleteBookmarkDialog } from "./components/delete-bookmark-dialog";
import { ConfirmActionDialog } from "./components/confirm-action-dialog";
import { LogoutDialog } from "./components/logout-dialog";
import { BookmarkDialog } from "./components/bookmark-dialog";
import { CollectionDialog } from "./components/collection-dialog";
import { ReaderDialog } from "./components/reader-dialog";
import { AssetViewer } from "./components/asset-viewer";
import { BulkDialog } from "./components/bulk-dialog";
import { AnnotationDialog } from "./components/annotation-dialog";
import { ReauthDialog } from "./components/reauth-dialog";
import { ImportDialog } from "./components/import-dialog";
import { ExportDialog } from "./components/export-dialog";
import { HelpDialog } from "./components/help-dialog";

export function Shell({ onReady }) {
  useLayoutEffect(() => {
    let active = true,
      dispose;
    queueMicrotask(() => {
      if (active) dispose = onReady?.();
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [onReady]);
  return (
    <>
      <LoginView />
      <AppView />
      <NavigationDialog />
      <DeleteBookmarkDialog />
      <ConfirmActionDialog />
      <LogoutDialog />
      <BookmarkDialog />
      <CollectionDialog />
      <ReaderDialog />
      <AssetViewer />
      <BulkDialog />
      <AnnotationDialog />
      <ReauthDialog />
      <ImportDialog />
      <ExportDialog />
      <HelpDialog />
    </>
  );
}
