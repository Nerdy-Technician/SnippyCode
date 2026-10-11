import copy from 'clipboard-copy';

/**
 * Copy text that is still being fetched. Handing the clipboard a promise
 * inside the click keeps the user gesture (Safari drops it after an await);
 * elsewhere, fall back to copying once the text arrives.
 */
export const copyAsync = async (text: Promise<string>): Promise<void> => {
  const ClipboardItemCtor = (window as any).ClipboardItem;

  if (ClipboardItemCtor && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItemCtor({
          'text/plain': text.then(value => new Blob([value], { type: 'text/plain' }))
        })
      ]);
      return;
    } catch {
      // Fall through, e.g. when the browser refuses promise-based items
    }
  }

  await copy(await text);
};
