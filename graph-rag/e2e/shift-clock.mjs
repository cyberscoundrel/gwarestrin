// Moves a process's clock ahead by CLOCK_SHIFT_DAYS, so e2e.sh can run graph-rag
// and the scenarios at a later date (NODE_OPTIONS=--import). Loaded only when
// that variable is set; nothing here runs in a normal harness run.
const days = Number(process.env.CLOCK_SHIFT_DAYS ?? 0);
if (days) {
  const offset = days * 86_400_000;
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + offset);
    }
    static now() {
      return RealDate.now() + offset;
    }
  };
}
