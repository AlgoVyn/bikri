export type ApplyUpdate = () => void;

export type UpdateSnapshot = {
  updateReady: boolean;
  applyUpdate: ApplyUpdate;
};

let snapshot: UpdateSnapshot = {
  updateReady: false,
  applyUpdate: () => {},
};

const listeners = new Set<() => void>();

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot;
}

export function setUpdateReady(ready: boolean, apply?: ApplyUpdate): void {
  snapshot = {
    updateReady: ready,
    applyUpdate: apply ?? snapshot.applyUpdate,
  };
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetUpdateStore(): void {
  snapshot = { updateReady: false, applyUpdate: () => {} };
  for (const listener of listeners) {
    listener();
  }
}
