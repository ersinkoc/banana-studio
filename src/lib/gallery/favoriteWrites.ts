/** Favorite writes for one media item run in click order, so the saved value is
 * always the last successful write. A failure only rolls back when no newer
 * click is waiting, and it restores the last value that was actually saved. */
export const createFavoriteWriter = (
  write: (id: string, isFavorite: boolean) => Promise<void>,
  rollback: (id: string, isFavorite: boolean) => void,
  onError: (error: unknown) => void = () => {},
) => {
  const pending = new Map<string, { seq: number; saved: boolean; tail: Promise<void> }>();
  return (id: string, previous: boolean, next: boolean): Promise<void> => {
    let entry = pending.get(id);
    if (!entry) pending.set(id, entry = { seq: 0, saved: previous, tail: Promise.resolve() });
    const item = entry, seq = ++item.seq;
    const settle = () => { if (item.seq === seq) pending.delete(id); };
    item.tail = item.tail.then(() => write(id, next)).then(
      () => { item.saved = next; settle(); },
      error => {
        onError(error);
        if (item.seq === seq) rollback(id, item.saved);
        settle();
      },
    );
    return item.tail;
  };
};
