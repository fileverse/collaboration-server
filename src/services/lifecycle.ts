// Set at the top of the graceful shutdown, before io.close() fires "disconnecting" for
// every socket on the instance. Per-socket work that only matters on a live server (the
// wire-format ratchet) checks it and returns: the reconnect auth after the restart
// resolves the same state, and running it here only burns a Mongo read and a
// cross-instance enumeration per socket against peers that are also going down.
let draining = false;

export const markDraining = (): void => {
  draining = true;
};

export const isDraining = (): boolean => draining;

export const resetDrainingForTests = (): void => {
  draining = false;
};
