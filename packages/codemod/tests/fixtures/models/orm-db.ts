// The same module after the migration: it re-exports dynotable-orm.
export * from 'dynotable-orm';
export const nowUnix = (): number => Math.floor(Date.now() / 1000);
export type WithDelete<M> = M;
export type Saved<T> = T;
