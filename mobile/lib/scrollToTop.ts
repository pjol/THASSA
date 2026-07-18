// Tab scroll-to-top registry: screens register a handler under their tab
// route name; re-tapping the already-active tab in the bottom bar invokes it
// (standard social-media behavior).

const handlers = new Map<string, () => void>();

export function registerScrollToTop(tab: string, fn: () => void): () => void {
  handlers.set(tab, fn);
  return () => {
    if (handlers.get(tab) === fn) handlers.delete(tab);
  };
}

export function scrollTabToTop(tab: string) {
  handlers.get(tab)?.();
}
