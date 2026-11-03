/** Resolves after pending promise callbacks and I/O callbacks have run. */
const flush = () => new Promise<void>((resolve) => {
  setImmediate(resolve);
});

export default flush;
